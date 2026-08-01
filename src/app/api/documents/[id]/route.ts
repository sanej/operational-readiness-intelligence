// Remove a document from a corpus — Vectorize, R2, and D1.

import { NextRequest, NextResponse } from 'next/server';
import { DocumentRemovalService } from '@/core/ingestion/delete';
import { defaultCorpusId, getDomainPack } from '@/domains';
import { getBindings, toApiError } from '@/lib/bindings';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: 'A document id is required.' }, { status: 400 });
    }

    // Corpus scoping is enforced in the service, not just here, so the check
    // holds however the route is reached.
    const domain = request.nextUrl.searchParams.get('domain');
    const corpusId = domain
      ? (request.nextUrl.searchParams.get('corpus') ?? defaultCorpusId(getDomainPack(domain).id))
      : (request.nextUrl.searchParams.get('corpus') ?? undefined);

    const service = new DocumentRemovalService(getBindings());
    const result = await service.remove(id, corpusId);

    if (!result.success) {
      // "Not found" is a client error; anything else is a genuine failure.
      const status = result.error?.includes('not found') ? 404 : 500;
      return NextResponse.json({ error: result.error, documentId: id }, { status });
    }

    return NextResponse.json(result);
  } catch (error) {
    const { message, status } = toApiError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
