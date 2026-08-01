// Domain-pack contract tests.
//
// These enforce the composability claim: a pack is a self-contained
// configuration, and the shared pipeline holds no industry logic. If someone
// adds a third pack, these tests tell them what it must provide.

import { describe, expect, it } from 'vitest';
import { DOMAIN_PACKS, getDomainPack, listDomains } from '..';
import { EVIDENCE_STATUSES, QUERY_INTENTS } from '../../core/types';
import industrialEvals from '../industrial/evals.json';
import pharmaEvals from '../pharma/evals.json';

const packs = Object.values(DOMAIN_PACKS);

describe('domain registry', () => {
  it('registers both shipped domains', () => {
    expect(Object.keys(DOMAIN_PACKS).sort()).toEqual(['industrial', 'pharma']);
    expect(listDomains()).toHaveLength(2);
  });

  it('throws a helpful error for an unknown domain', () => {
    expect(() => getDomainPack('nuclear')).toThrow(/Unknown domain "nuclear"/);
    expect(() => getDomainPack(undefined)).toThrow(/Available: industrial, pharma/);
  });
});

describe.each(packs)('$id pack', (pack) => {
  it('satisfies the DomainPack contract', () => {
    expect(pack.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(pack.displayName.length).toBeGreaterThan(0);
    expect(pack.description.length).toBeGreaterThan(0);
    expect(pack.documentTypes.length).toBeGreaterThan(0);
    expect(pack.filterableFields.length).toBeGreaterThan(0);
    expect(Object.keys(pack.terminology).length).toBeGreaterThan(0);
    // Every intent needs a structure, and general Q&A must be the leanest —
    // a factual lookup answered in report form buries the answer.
    for (const intent of QUERY_INTENTS) {
      expect(pack.answerStructure[intent].length).toBeGreaterThan(0);
    }
    expect(pack.answerStructure.GENERAL_QA.length).toBeLessThan(
      pack.answerStructure.READINESS_ASSESSMENT.length
    );
    expect(pack.defaultTopK).toBeGreaterThan(0);
  });

  it('supplies at least five representative questions', () => {
    expect(pack.queryExamples.length).toBeGreaterThanOrEqual(5);
    for (const example of pack.queryExamples) {
      expect(example.question.trim().length).toBeGreaterThan(0);
      expect(example.category.trim().length).toBeGreaterThan(0);
    }
  });

  it('penalises superseded and draft documents and boosts the current revision', () => {
    const weights = pack.authorityWeights;
    expect(weights.superseded).toBeLessThan(1);
    expect(weights.draft).toBeLessThan(1);
    expect(weights.withdrawn).toBeLessThan(weights.superseded);
    expect(weights.mostRecentRevision).toBeGreaterThan(1);
    // Additive bonus: must promote an unresolved action, but stay small enough
    // that it breaks ties rather than overriding relevance.
    expect(weights.openAction).toBeGreaterThan(0);
    expect(weights.openAction).toBeLessThanOrEqual(0.1);
  });

  it('instructs the model not to imply approval', () => {
    // The single most important property of a domain prompt.
    expect(pack.systemPrompt.toLowerCase()).toMatch(
      /do not|does not|never|not\b.*(approve|authoris|authoriz|certif|releas)/
    );
  });

  it('validates well-formed metadata and rejects unknown fields', () => {
    const documentType = pack.documentTypes[0].id;

    const valid = pack.metadataSchema.safeParse({
      title: 'A document',
      documentType,
      revision: 'Rev 1',
      status: 'active',
    });
    expect(valid.success).toBe(true);

    // Strict mode: a typo must fail rather than becoming a filter that silently
    // never matches.
    const typo = pack.metadataSchema.safeParse({
      title: 'A document',
      documentType,
      assetID: 'C-101',
    });
    expect(typo.success).toBe(false);
  });

  it('accepts an unclassified document but still rejects an invalid type', () => {
    // An ad-hoc upload has no front matter, so documentType is absent. That
    // must ingest — but the vocabulary stays closed, so a typo or an invented
    // type is still an error.
    const untyped = pack.metadataSchema.safeParse({ title: 'Vendor inspection report' });
    expect(untyped.success).toBe(true);

    const invalid = pack.metadataSchema.safeParse({
      title: 'X',
      documentType: 'operatng_procedure',
    });
    expect(invalid.success).toBe(false);
  });

  it('rejects a document type from another domain', () => {
    const otherPack = packs.find((p) => p.id !== pack.id)!;
    const foreignType = otherPack.documentTypes[0].id;

    const result = pack.metadataSchema.safeParse({ title: 'X', documentType: foreignType });
    expect(result.success).toBe(false);
  });

  it('defaults status to active when unspecified', () => {
    const result = pack.metadataSchema.safeParse({
      title: 'X',
      documentType: pack.documentTypes[0].id,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { status?: string }).status).toBe('active');
    }
  });
});

describe.each([
  ['industrial', industrialEvals],
  ['pharma', pharmaEvals],
])('%s eval suite', (domain, suite) => {
  it('declares at least five cases for the right domain', () => {
    expect(suite.domain).toBe(domain);
    expect(suite.cases.length).toBeGreaterThanOrEqual(5);
  });

  it('uses unique case ids', () => {
    const ids = suite.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references valid evidence statuses', () => {
    for (const testCase of suite.cases) {
      for (const status of testCase.expectedStatus ?? []) {
        expect(EVIDENCE_STATUSES).toContain(status);
      }
    }
  });

  it('covers the required evaluation dimensions', () => {
    const covered = new Set(suite.cases.flatMap((c) => c.dimensions));
    for (const dimension of [
      'correct_source_retrieval',
      'authoritative_revision',
      'multi_document_synthesis',
      'citation_support',
      'unsupported_answer_abstention',
      'missing_information',
      'conflicting_document_detection',
    ]) {
      expect(covered).toContain(dimension);
    }
  });
});
