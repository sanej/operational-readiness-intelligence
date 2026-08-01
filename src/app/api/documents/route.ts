// Corpus document list, with ingestion status.

import { NextRequest, NextResponse } from 'next/server';
import { Storage } from '@/core/storage';
import { getDomainPack, defaultCorpusId } from '@/domains';
import { getBindings, toApiError } from '@/lib/bindings';

export async function GET(request: NextRequest) {
  try {
    const domain = request.nextUrl.searchParams.get('domain') ?? 'industrial';
    const pack = getDomainPack(domain);
    const corpusId = request.nextUrl.searchParams.get('corpus') ?? defaultCorpusId(pack.id);

    const storage = new Storage(getBindings());
    const rows = await storage.d1.listDocuments(corpusId);

    return NextResponse.json({
      corpusId,
      domain: pack.id,
      documents: rows.map((row) => ({
        id: row.id,
        fileName: row.original_file_name,
        title: row.title ?? row.original_file_name,
        documentType: row.document_type,
        revision: row.revision,
        effectiveDate: row.effective_date,
        authority: row.authority,
        docStatus: row.doc_status,
        extractionMethod: row.extraction_method,
        pageCount: row.page_count,
        chunkCount: row.chunk_count,
        status: row.status,
        errorMessage: row.error_message,
        metadata: JSON.parse(row.metadata || '{}'),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    const { message, status } = toApiError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
