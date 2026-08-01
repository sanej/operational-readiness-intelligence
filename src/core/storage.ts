// Storage layer: D1 (metadata), R2 (files + parsed artifacts), Vectorize
// (embeddings).
//
// One class per service, plus a Storage facade that carries all three. Every
// method here is domain-agnostic — domain fields travel inside the metadata
// JSON column and the Vectorize metadata bag.

import type { D1Database, R2Bucket, VectorizeIndex } from '@cloudflare/workers-types';
import type {
  ChunkRecord,
  DocumentMetadata,
  DocumentRecord,
  EvidenceStatus,
  GroundedAnswer,
  ExtractionMethod,
} from './types';
import { newId, parsedR2Key, r2Key } from './ids';

// ===========================================================================
// R2
// ===========================================================================

export class R2Store {
  constructor(private readonly bucket: R2Bucket) {}

  async putOriginal(
    corpusId: string,
    docId: string,
    fileName: string,
    content: ArrayBuffer | Uint8Array,
    mimeType: string
  ): Promise<string> {
    const key = r2Key(corpusId, docId, fileName);
    await this.bucket.put(key, content as ArrayBuffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { corpusId, documentId: docId, uploadedAt: new Date().toISOString() },
    });
    return key;
  }

  /** The normalized extraction, kept so re-chunking never re-runs OCR. */
  async putParsed(corpusId: string, docId: string, parsed: unknown): Promise<string> {
    const key = parsedR2Key(corpusId, docId);
    await this.bucket.put(key, JSON.stringify(parsed), {
      httpMetadata: { contentType: 'application/json' },
    });
    return key;
  }

  async getParsed<T>(key: string): Promise<T | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as T;
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const obj = await this.bucket.get(key);
    return obj ? obj.arrayBuffer() : null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

// ===========================================================================
// D1
// ===========================================================================

export interface CorpusRow {
  id: string;
  domain: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  corpus_id: string;
  domain: string;
  file_name: string;
  original_file_name: string;
  file_type: string;
  mime_type: string;
  file_size: number;
  r2_key: string;
  parsed_r2_key: string | null;
  content_hash: string;
  extraction_method: string;
  page_count: number | null;
  language: string | null;
  title: string | null;
  document_type: string | null;
  revision: string | null;
  effective_date: string | null;
  authority: string | null;
  doc_status: string | null;
  superseded_by: string | null;
  metadata: string;
  status: string;
  error_message: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  corpus_id: string;
  domain: string;
  content: string;
  chunk_index: number;
  total_chunks: number;
  page_number: number | null;
  section: string | null;
  heading_path: string | null;
  token_count: number;
  vector_id: string | null;
  metadata: string;
  created_at: string;
}

export class D1Store {
  constructor(private readonly db: D1Database) {}

  // -- corpora --------------------------------------------------------------

  async upsertCorpus(
    id: string,
    domain: string,
    name: string,
    description?: string
  ): Promise<CorpusRow> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO corpora (id, domain, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           updated_at = excluded.updated_at`
      )
      .bind(id, domain, name, description ?? null, now, now)
      .run();
    return (await this.getCorpus(id))!;
  }

  async getCorpus(id: string): Promise<CorpusRow | null> {
    return (
      (await this.db.prepare('SELECT * FROM corpora WHERE id = ?').bind(id).first<CorpusRow>()) ??
      null
    );
  }

  async listCorpora(domain?: string): Promise<CorpusRow[]> {
    const stmt = domain
      ? this.db.prepare('SELECT * FROM corpora WHERE domain = ? ORDER BY created_at DESC').bind(domain)
      : this.db.prepare('SELECT * FROM corpora ORDER BY created_at DESC');
    return (await stmt.all<CorpusRow>()).results;
  }

  // -- documents ------------------------------------------------------------

  async findDocumentByHash(corpusId: string, hash: string): Promise<DocumentRow | null> {
    return (
      (await this.db
        .prepare('SELECT * FROM documents WHERE corpus_id = ? AND content_hash = ?')
        .bind(corpusId, hash)
        .first<DocumentRow>()) ?? null
    );
  }

  /**
   * Insert or replace a document row.
   *
   * Upsert rather than insert so re-ingesting a corrected file with the same
   * content updates metadata in place instead of failing on the primary key.
   */
  async upsertDocument(doc: {
    id: string;
    corpusId: string;
    domain: string;
    fileName: string;
    originalFileName: string;
    fileType: string;
    mimeType: string;
    fileSize: number;
    r2Key: string;
    parsedR2Key?: string;
    contentHash: string;
    extractionMethod: ExtractionMethod;
    pageCount?: number;
    language?: string;
    metadata: DocumentMetadata;
    status: string;
    errorMessage?: string;
    chunkCount?: number;
  }): Promise<DocumentRow> {
    const now = new Date().toISOString();
    const m = doc.metadata;

    await this.db
      .prepare(
        `INSERT INTO documents (
           id, corpus_id, domain, file_name, original_file_name, file_type, mime_type,
           file_size, r2_key, parsed_r2_key, content_hash, extraction_method, page_count,
           language, title, document_type, revision, effective_date, authority, doc_status,
           superseded_by, metadata, status, error_message, chunk_count, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           parsed_r2_key  = excluded.parsed_r2_key,
           title          = excluded.title,
           document_type  = excluded.document_type,
           revision       = excluded.revision,
           effective_date = excluded.effective_date,
           authority      = excluded.authority,
           doc_status     = excluded.doc_status,
           superseded_by  = excluded.superseded_by,
           metadata       = excluded.metadata,
           status         = excluded.status,
           error_message  = excluded.error_message,
           chunk_count    = excluded.chunk_count,
           updated_at     = excluded.updated_at`
      )
      .bind(
        doc.id,
        doc.corpusId,
        doc.domain,
        doc.fileName,
        doc.originalFileName,
        doc.fileType,
        doc.mimeType,
        doc.fileSize,
        doc.r2Key,
        doc.parsedR2Key ?? null,
        doc.contentHash,
        doc.extractionMethod,
        doc.pageCount ?? null,
        doc.language ?? null,
        m.title ?? null,
        m.documentType ?? null,
        m.revision ?? null,
        m.effectiveDate ?? null,
        m.authority ?? null,
        m.status ?? null,
        m.supersededBy ?? null,
        JSON.stringify(m.extra ?? {}),
        doc.status,
        doc.errorMessage ?? null,
        doc.chunkCount ?? 0,
        now,
        now
      )
      .run();

    return (await this.getDocument(doc.id))!;
  }

  async getDocument(id: string): Promise<DocumentRow | null> {
    return (
      (await this.db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first<DocumentRow>()) ??
      null
    );
  }

  async listDocuments(corpusId: string): Promise<DocumentRow[]> {
    return (
      await this.db
        .prepare('SELECT * FROM documents WHERE corpus_id = ? ORDER BY created_at DESC')
        .bind(corpusId)
        .all<DocumentRow>()
    ).results;
  }

  async updateDocumentStatus(
    id: string,
    status: string,
    errorMessage?: string,
    chunkCount?: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE documents
           SET status = ?, error_message = ?,
               chunk_count = COALESCE(?, chunk_count), updated_at = ?
         WHERE id = ?`
      )
      .bind(status, errorMessage ?? null, chunkCount ?? null, new Date().toISOString(), id)
      .run();
  }

  async deleteDocument(id: string): Promise<void> {
    // chunks and citations cascade via foreign keys.
    await this.db.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
  }

  // -- chunks ---------------------------------------------------------------

  /** D1 has no interactive transactions; batch() is one implicit transaction. */
  async insertChunks(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;

    const stmt = this.db.prepare(
      `INSERT INTO chunks (
         id, document_id, corpus_id, domain, content, chunk_index, total_chunks,
         page_number, section, heading_path, token_count, vector_id, metadata, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         content      = excluded.content,
         total_chunks = excluded.total_chunks,
         page_number  = excluded.page_number,
         section      = excluded.section,
         heading_path = excluded.heading_path,
         token_count  = excluded.token_count,
         vector_id    = excluded.vector_id,
         metadata     = excluded.metadata`
    );

    const now = new Date().toISOString();

    // D1 caps statements per batch; chunk the batch itself.
    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      await this.db.batch(
        slice.map((c) =>
          stmt.bind(
            c.id,
            c.documentId,
            c.corpusId,
            c.domain,
            c.content,
            c.chunkIndex,
            c.totalChunks,
            c.provenance.pageNumber ?? null,
            c.provenance.section ?? null,
            c.provenance.headingPath ?? null,
            c.tokenCount,
            c.vectorId ?? null,
            JSON.stringify(c.metadata),
            now
          )
        )
      );
    }
  }

  async getChunksByVectorIds(vectorIds: string[]): Promise<ChunkRow[]> {
    if (vectorIds.length === 0) return [];
    const placeholders = vectorIds.map(() => '?').join(',');
    return (
      await this.db
        .prepare(`SELECT * FROM chunks WHERE vector_id IN (${placeholders})`)
        .bind(...vectorIds)
        .all<ChunkRow>()
    ).results;
  }

  async listChunksByDocument(documentId: string): Promise<ChunkRow[]> {
    return (
      await this.db
        .prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index')
        .bind(documentId)
        .all<ChunkRow>()
    ).results;
  }

  async listVectorIdsByDocument(documentId: string): Promise<string[]> {
    const rows = (
      await this.db
        .prepare('SELECT vector_id FROM chunks WHERE document_id = ? AND vector_id IS NOT NULL')
        .bind(documentId)
        .all<{ vector_id: string }>()
    ).results;
    return rows.map((r) => r.vector_id);
  }

  // -- questions and citations ---------------------------------------------

  async saveAnswer(answer: GroundedAnswer): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO questions (
           id, corpus_id, domain, question, answer, intent, evidence_status, claimed_status,
           confidence, missing_evidence, conflicts, verification_required,
           retrieved_chunks, warnings, retrieval_ms, generation_ms, total_ms,
           prompt_tokens, completion_tokens, model, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        answer.id,
        answer.corpusId,
        answer.domain,
        answer.question,
        answer.answer,
        answer.intent,
        answer.evidenceStatus,
        answer.claimedStatus ?? null,
        answer.confidence,
        JSON.stringify(answer.missingEvidence),
        JSON.stringify(answer.conflicts),
        JSON.stringify(answer.verificationRequired),
        // Store a trimmed projection: full chunk text is already in `chunks`.
        JSON.stringify(
          answer.retrievedChunks.map((c) => ({
            chunkId: c.chunkId,
            documentId: c.documentId,
            score: c.score,
            adjustedScore: c.adjustedScore,
          }))
        ),
        JSON.stringify(answer.warnings),
        answer.timings.retrievalMs,
        answer.timings.generationMs,
        answer.timings.totalMs,
        answer.usage?.promptTokens ?? null,
        answer.usage?.completionTokens ?? null,
        answer.model,
        answer.createdAt
      )
      .run();

    if (answer.citations.length > 0) {
      const stmt = this.db.prepare(
        `INSERT INTO citations (
           id, question_id, chunk_id, document_id, cited_content, document_title,
           page_number, section, revision, relevance_score, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      await this.db.batch(
        answer.citations.map((c) =>
          stmt.bind(
            c.id,
            answer.id,
            c.chunkId,
            c.documentId,
            c.citedContent,
            c.documentTitle ?? null,
            c.pageNumber ?? null,
            c.section ?? null,
            c.revision ?? null,
            c.relevanceScore,
            answer.createdAt
          )
        )
      );
    }
  }

  async listQuestions(corpusId: string, limit = 20): Promise<
    Array<{
      id: string;
      question: string;
      answer: string;
      evidence_status: EvidenceStatus;
      created_at: string;
    }>
  > {
    return (
      await this.db
        .prepare(
          `SELECT id, question, answer, evidence_status, created_at
             FROM questions WHERE corpus_id = ?
            ORDER BY created_at DESC LIMIT ?`
        )
        .bind(corpusId, limit)
        .all<{
          id: string;
          question: string;
          answer: string;
          evidence_status: EvidenceStatus;
          created_at: string;
        }>()
    ).results;
  }

  // -- evaluation -----------------------------------------------------------

  async createEvalRun(domain: string, corpusId: string, totalCases: number): Promise<string> {
    const id = newId('run');
    await this.db
      .prepare(
        `INSERT INTO evaluation_runs (id, domain, corpus_id, total_cases, passed_cases, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .bind(id, domain, corpusId, totalCases, new Date().toISOString())
      .run();
    return id;
  }

  async saveEvalRecord(record: {
    runId: string;
    caseId: string;
    domain: string;
    questionId?: string;
    question: string;
    expectedStatus?: string;
    actualStatus?: string;
    checks: Record<string, boolean>;
    passed: boolean;
    failureReasons: string[];
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO evaluation_records (
           id, run_id, case_id, domain, question_id, question, expected_status,
           actual_status, checks, passed, failure_reasons, latency_ms,
           prompt_tokens, completion_tokens, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        newId('evr'),
        record.runId,
        record.caseId,
        record.domain,
        record.questionId ?? null,
        record.question,
        record.expectedStatus ?? null,
        record.actualStatus ?? null,
        JSON.stringify(record.checks),
        record.passed ? 1 : 0,
        JSON.stringify(record.failureReasons),
        record.latencyMs ?? null,
        record.promptTokens ?? null,
        record.completionTokens ?? null,
        new Date().toISOString()
      )
      .run();
  }

  async finalizeEvalRun(runId: string, passedCases: number, notes?: string): Promise<void> {
    await this.db
      .prepare('UPDATE evaluation_runs SET passed_cases = ?, notes = ? WHERE id = ?')
      .bind(passedCases, notes ?? null, runId)
      .run();
  }
}

// ===========================================================================
// Vectorize
// ===========================================================================

/**
 * Vectorize metadata values must be primitives. Namespacing is by domain, so
 * the industrial and pharma corpora never retrieve each other's evidence even
 * though they share one index.
 */
export type VectorMetadata = Record<string, string | number | boolean>;

export class VectorStore {
  constructor(private readonly index: VectorizeIndex) {}

  async upsert(
    vectors: Array<{ id: string; values: number[]; metadata: VectorMetadata }>,
    namespace: string
  ): Promise<void> {
    if (vectors.length === 0) return;

    // Vectorize caps vectors per upsert call.
    const BATCH = 100;
    for (let i = 0; i < vectors.length; i += BATCH) {
      await this.index.upsert(
        vectors.slice(i, i + BATCH).map((v) => ({
          id: v.id,
          values: v.values,
          namespace,
          metadata: { ...v.metadata, namespace },
        }))
      );
    }
  }

  async query(
    vector: number[],
    opts: { topK: number; namespace: string; filter?: Record<string, string | number | boolean> }
  ): Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>> {
    const res = await this.index.query(vector, {
      topK: opts.topK,
      namespace: opts.namespace,
      filter: opts.filter as never,
      returnValues: false,
      returnMetadata: 'all',
    });
    return res.matches.map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata as Record<string, unknown> | undefined,
    }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.index.deleteByIds(ids);
  }
}

// ===========================================================================
// Facade
// ===========================================================================

export class Storage {
  readonly d1: D1Store;
  readonly r2: R2Store;
  readonly vectors: VectorStore;

  constructor(bindings: { DB: D1Database; R2_BUCKET: R2Bucket; VECTORIZE: VectorizeIndex }) {
    this.d1 = new D1Store(bindings.DB);
    this.r2 = new R2Store(bindings.R2_BUCKET);
    this.vectors = new VectorStore(bindings.VECTORIZE);
  }
}

/** Rehydrate the typed record from its flat D1 row. */
export function documentFromRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    corpusId: row.corpus_id,
    domain: row.domain,
    fileName: row.file_name,
    originalFileName: row.original_file_name,
    fileType: row.file_type,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    r2Key: row.r2_key,
    parsedR2Key: row.parsed_r2_key ?? undefined,
    contentHash: row.content_hash,
    extractionMethod: row.extraction_method as ExtractionMethod,
    pageCount: row.page_count ?? undefined,
    language: row.language ?? undefined,
    metadata: {
      title: row.title ?? undefined,
      documentType: row.document_type ?? undefined,
      revision: row.revision ?? undefined,
      effectiveDate: row.effective_date ?? undefined,
      authority: row.authority ?? undefined,
      status: (row.doc_status as DocumentMetadata['status']) ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      extra: JSON.parse(row.metadata || '{}'),
    },
    status: row.status as DocumentRecord['status'],
    errorMessage: row.error_message ?? undefined,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
