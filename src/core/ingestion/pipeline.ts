// Ingestion pipeline: R2 -> normalize -> chunk -> embed -> Vectorize -> D1.
//
// Shared by the web upload route and the CLI, so a document ingested either
// way lands identically indexed.
//
// Idempotent by construction: document, chunk and vector ids are pure
// functions of (corpus, content), so re-ingesting the same file upserts in
// place rather than duplicating the corpus.

import { createConfig, countTokens, type OriBindings } from '../config';
import { chunkPages } from '../chunking/chunker';
import { EmbeddingService } from '../embeddings/mistral';
import { chunkId as makeChunkId, contentHash, documentId as makeDocumentId, r2Key, vectorId as makeVectorId } from '../ids';
import { Storage, type VectorMetadata } from '../storage';
import type { ChunkRecord, DocumentMetadata, DomainPack } from '../types';
import { detectFileType, mimeTypeFor, normalizeDocument } from './normalize';

export interface IngestInput {
  corpusId: string;
  fileName: string;
  content: ArrayBuffer | Uint8Array;
  mimeType?: string;
  /**
   * Metadata supplied by the caller (e.g. the upload form). Merged over
   * anything found in the file's front matter, then validated by the pack.
   */
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  success: boolean;
  documentId: string;
  fileName: string;
  chunkCount: number;
  extractionMethod: string;
  pageCount: number;
  duplicate: boolean;
  metadata?: DocumentMetadata;
  errors: string[];
  warnings: string[];
  timings: { normalizeMs: number; embedMs: number; indexMs: number; totalMs: number };
}

/**
 * Split validated metadata into the fields the pipeline promotes to columns
 * and the domain-specific remainder.
 *
 * Only primitives survive into `extra`: Vectorize metadata cannot hold nested
 * objects, and arrays are joined so they remain filterable as strings.
 */
function partitionMetadata(validated: Record<string, unknown>): DocumentMetadata {
  const {
    title,
    documentType,
    revision,
    effectiveDate,
    authority,
    status,
    supersededBy,
    ...rest
  } = validated;

  const extra: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      extra[key] = value.map(String).join(', ');
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      extra[key] = value;
    } else {
      extra[key] = JSON.stringify(value);
    }
  }

  return {
    title: title as string | undefined,
    documentType: documentType as string | undefined,
    revision: revision as string | undefined,
    effectiveDate: effectiveDate as string | undefined,
    authority: authority as string | undefined,
    status: status as DocumentMetadata['status'],
    supersededBy: supersededBy as string | undefined,
    extra,
  };
}

export class IngestionPipeline {
  private readonly storage: Storage;
  private readonly embeddings: EmbeddingService;
  private readonly config: ReturnType<typeof createConfig>;

  constructor(
    bindings: OriBindings,
    private readonly pack: DomainPack
  ) {
    this.config = createConfig(bindings);
    this.storage = new Storage(bindings);
    this.embeddings = new EmbeddingService(this.config.mistral);
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];

    const fileType = detectFileType(input.fileName, input.mimeType);
    const mimeType = input.mimeType || mimeTypeFor(fileType);

    const bytes =
      input.content instanceof Uint8Array ? input.content : new Uint8Array(input.content);

    const hash = await contentHash(bytes);
    const docId = await makeDocumentId(input.corpusId, hash);

    const empty = {
      documentId: docId,
      fileName: input.fileName,
      chunkCount: 0,
      extractionMethod: 'none',
      pageCount: 0,
      duplicate: false,
      timings: { normalizeMs: 0, embedMs: 0, indexMs: 0, totalMs: 0 },
    };

    // -- duplicate check ----------------------------------------------------
    const existing = await this.storage.d1.findDocumentByHash(input.corpusId, hash);
    if (existing && existing.status === 'indexed') {
      return {
        ...empty,
        success: true,
        duplicate: true,
        chunkCount: existing.chunk_count,
        extractionMethod: existing.extraction_method,
        pageCount: existing.page_count ?? 0,
        errors: [],
        warnings: ['Already indexed with identical content; skipped.'],
        timings: { ...empty.timings, totalMs: Date.now() - startedAt },
      };
    }

    try {
      // -- normalize --------------------------------------------------------
      const normalizeStart = Date.now();
      const normalized = await normalizeDocument(bytes, input.fileName, mimeType, this.config.mistral);
      const normalizeMs = Date.now() - normalizeStart;

      // -- metadata: front matter, overridden by caller, validated by pack ---
      const merged: Record<string, unknown> = {
        ...(normalized.frontMatter ?? {}),
        ...(input.metadata ?? {}),
      };
      if (!merged.title) merged.title = input.fileName.replace(/\.[^.]+$/, '');

      const validation = this.pack.metadataSchema.safeParse(merged);
      if (!validation.success) {
        const detail = validation.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new Error(`Metadata failed ${this.pack.displayName} validation — ${detail}`);
      }

      const metadata = partitionMetadata(validation.data);

      // Record the document before chunking so a later failure leaves a row
      // marked failed rather than nothing at all.
      const key = r2Key(input.corpusId, docId, input.fileName);
      await this.storage.d1.upsertDocument({
        id: docId,
        corpusId: input.corpusId,
        domain: this.pack.id,
        fileName: input.fileName,
        originalFileName: input.fileName,
        fileType,
        mimeType,
        fileSize: bytes.byteLength,
        r2Key: key,
        contentHash: hash,
        extractionMethod: normalized.extractionMethod,
        pageCount: normalized.pageCount,
        metadata,
        status: 'processing',
      });

      // -- persist original + parsed artifact --------------------------------
      await this.storage.r2.putOriginal(input.corpusId, docId, input.fileName, bytes, mimeType);
      const parsedKey = await this.storage.r2.putParsed(input.corpusId, docId, {
        pages: normalized.pages,
        extractionMethod: normalized.extractionMethod,
        metadata,
      });

      // -- chunk -------------------------------------------------------------
      const raw = chunkPages(normalized.pages, this.config.chunking);
      if (raw.length === 0) {
        throw new Error('No chunks were produced — the document appears to be empty.');
      }

      // Denormalise document metadata onto every chunk so Vectorize can filter
      // on it without a D1 round-trip during retrieval.
      const chunkMetadata: VectorMetadata = {
        corpusId: input.corpusId,
        documentId: docId,
        domain: this.pack.id,
        ...(metadata.documentType ? { documentType: metadata.documentType } : {}),
        ...(metadata.revision ? { revision: metadata.revision } : {}),
        ...(metadata.effectiveDate ? { effectiveDate: metadata.effectiveDate } : {}),
        ...(metadata.status ? { docStatus: metadata.status } : {}),
        ...(metadata.authority ? { authority: metadata.authority } : {}),
        ...metadata.extra,
      };

      const chunks: ChunkRecord[] = [];
      for (let i = 0; i < raw.length; i++) {
        const cid = await makeChunkId(docId, i);
        chunks.push({
          id: cid,
          documentId: docId,
          corpusId: input.corpusId,
          domain: this.pack.id,
          content: raw[i].content,
          chunkIndex: i,
          totalChunks: raw.length,
          provenance: raw[i].provenance,
          tokenCount: raw[i].tokenCount || countTokens(raw[i].content),
          vectorId: await makeVectorId(cid),
          metadata: {
            ...chunkMetadata,
            ...(raw[i].provenance.section ? { section: raw[i].provenance.section! } : {}),
          },
        });
      }

      // -- embed --------------------------------------------------------------
      const embedStart = Date.now();
      // Prefix each chunk with its heading path: an isolated procedure step
      // ("Verify the valve is closed") embeds poorly without the context that
      // says which system and which procedure it belongs to.
      const { embeddings } = await this.embeddings.embed(
        chunks.map((c) => {
          const path = c.provenance.headingPath;
          const title = metadata.title;
          const prefix = [title, path].filter(Boolean).join(' > ');
          return prefix ? `${prefix}\n\n${c.content}` : c.content;
        })
      );
      const embedMs = Date.now() - embedStart;

      if (embeddings.length !== chunks.length) {
        throw new Error(
          `Embedding count mismatch: ${embeddings.length} returned for ${chunks.length} chunks.`
        );
      }

      // -- index --------------------------------------------------------------
      const indexStart = Date.now();
      await this.storage.vectors.upsert(
        chunks.map((c, i) => ({ id: c.vectorId!, values: embeddings[i], metadata: c.metadata })),
        this.pack.id
      );
      await this.storage.d1.insertChunks(chunks);
      const indexMs = Date.now() - indexStart;

      await this.storage.d1.upsertDocument({
        id: docId,
        corpusId: input.corpusId,
        domain: this.pack.id,
        fileName: input.fileName,
        originalFileName: input.fileName,
        fileType,
        mimeType,
        fileSize: bytes.byteLength,
        r2Key: key,
        parsedR2Key: parsedKey,
        contentHash: hash,
        extractionMethod: normalized.extractionMethod,
        pageCount: normalized.pageCount,
        metadata,
        status: 'indexed',
        chunkCount: chunks.length,
      });

      return {
        success: true,
        documentId: docId,
        fileName: input.fileName,
        chunkCount: chunks.length,
        extractionMethod: normalized.extractionMethod,
        pageCount: normalized.pageCount,
        duplicate: false,
        metadata,
        errors: [],
        warnings,
        timings: { normalizeMs, embedMs, indexMs, totalMs: Date.now() - startedAt },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Best-effort: mark the row failed so the UI can show why.
      await this.storage.d1
        .updateDocumentStatus(docId, 'failed', message)
        .catch(() => undefined);

      return {
        ...empty,
        success: false,
        errors: [message],
        warnings,
        timings: { ...empty.timings, totalMs: Date.now() - startedAt },
      };
    }
  }
}
