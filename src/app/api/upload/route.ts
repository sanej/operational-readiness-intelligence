// Document upload and ingestion.
//
// Runs the same IngestionPipeline as the CLI, so a document uploaded here is
// indexed identically to one ingested with `npm run ingest`.

import { NextRequest, NextResponse } from 'next/server';
import { IngestionPipeline } from '@/core/ingestion/pipeline';
import { Storage } from '@/core/storage';
import { defaultCorpusId, getDomainPack } from '@/domains';
import { getBindings, toApiError } from '@/lib/bindings';

/** Uploads are OCR-bound; give them room beyond the default. */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const domain = (formData.get('domain') as string) || 'industrial';
    const pack = getDomainPack(domain);
    const corpusId = (formData.get('corpus') as string) || defaultCorpusId(pack.id);

    const files = formData.getAll('files').filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files were provided.' }, { status: 400 });
    }

    // Metadata supplied by the upload form, applied to every file in the batch.
    // Merged over front matter, then validated by the domain pack.
    const metadataRaw = formData.get('metadata');
    let metadata: Record<string, unknown> | undefined;
    if (typeof metadataRaw === 'string' && metadataRaw.trim()) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch {
        return NextResponse.json({ error: 'metadata must be valid JSON.' }, { status: 400 });
      }
    }

    const bindings = getBindings();
    const storage = new Storage(bindings);
    await storage.d1.upsertCorpus(corpusId, pack.id, `${pack.displayName} corpus`, pack.description);

    const pipeline = new IngestionPipeline(bindings, pack);
    const results = [];

    for (const file of files) {
      const result = await pipeline.ingest({
        corpusId,
        fileName: file.name,
        content: await file.arrayBuffer(),
        mimeType: file.type || undefined,
        metadata,
      });

      results.push({
        fileName: result.fileName,
        success: result.success,
        duplicate: result.duplicate,
        documentId: result.documentId,
        chunkCount: result.chunkCount,
        pageCount: result.pageCount,
        extractionMethod: result.extractionMethod,
        errors: result.errors,
        warnings: result.warnings,
        totalMs: result.timings.totalMs,
      });
    }

    return NextResponse.json({
      corpusId,
      domain: pack.id,
      results,
      indexed: results.filter((r) => r.success && !r.duplicate).length,
      duplicates: results.filter((r) => r.duplicate).length,
      failed: results.filter((r) => !r.success).length,
    });
  } catch (error) {
    const { message, status } = toApiError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
