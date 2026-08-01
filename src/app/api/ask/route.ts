// Grounded question answering.
//
// Thin wrapper over AskPipeline — the same pipeline `npm run ask` uses. All
// retrieval, generation, and citation-validation logic lives in core.

import { NextRequest, NextResponse } from 'next/server';
import { AskPipeline } from '@/core/ask';
import { defaultCorpusId, getDomainPack } from '@/domains';
import { getBindings, toApiError } from '@/lib/bindings';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      domain?: string;
      corpus?: string;
      question?: string;
      topK?: number;
      filters?: Record<string, string>;
    };

    const question = body.question?.trim();
    if (!question) {
      return NextResponse.json({ error: 'A question is required.' }, { status: 400 });
    }

    const pack = getDomainPack(body.domain ?? 'industrial');
    const corpusId = body.corpus ?? defaultCorpusId(pack.id);

    const pipeline = new AskPipeline(getBindings(), pack);
    const answer = await pipeline.ask({
      corpusId,
      question,
      topK: body.topK,
      filters: body.filters,
    });

    return NextResponse.json({ answer });
  } catch (error) {
    const { message, status } = toApiError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
