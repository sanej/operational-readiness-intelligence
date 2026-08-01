// Domain metadata for the UI: selector options, example questions, filters.
//
// Served from the domain registry so the UI never hard-codes industry
// vocabulary — adding a domain pack makes it appear here automatically.

import { NextResponse } from 'next/server';
import { DOMAIN_PACKS, defaultCorpusId } from '@/domains';

export function GET() {
  return NextResponse.json({
    domains: Object.values(DOMAIN_PACKS).map((pack) => ({
      id: pack.id,
      displayName: pack.displayName,
      description: pack.description,
      corpusId: defaultCorpusId(pack.id),
      documentTypes: pack.documentTypes,
      filterableFields: pack.filterableFields,
      queryExamples: pack.queryExamples,
      answerStructure: pack.answerStructure,
    })),
  });
}
