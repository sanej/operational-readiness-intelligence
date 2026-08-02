// Tests for the grounding enforcement layer.
//
// These are the highest-value tests in the project: this module is what makes
// an ORI evidence status mean something. If it regresses, the system can
// report SUPPORTED for a claim nothing backs, and every downstream safeguard
// is built on that being impossible.

import { describe, expect, it } from 'vitest';
import {
  computeEvidenceSupport,
  enforceStatus,
  isQuoteGrounded,
  validateCitations,
} from '../validate';
import type { Citation, EvidenceConflict, RetrievedChunk } from '../../types';

function chunk(id: string, content: string): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    content,
    score: 0.8,
    adjustedScore: 0.8,
    provenance: { pageNumber: 1, section: 'Section 1' },
    documentTitle: `Document ${id}`,
    metadata: {},
  };
}

const CONFLICT: EvidenceConflict = {
  kind: 'revision',
  description: 'Two active revisions',
  chunkIds: ['a', 'b'],
  documentIds: ['doc-a', 'doc-b'],
};

describe('isQuoteGrounded', () => {
  const source =
    'Secondary vent flow on the non-drive-end dry gas seal measured 21 Nm³/h ' +
    'against an OEM alarm threshold of 15 Nm³/h.';

  it('accepts an exact quote', () => {
    expect(isQuoteGrounded('measured 21 Nm³/h', source)).toBe(true);
  });

  it('ignores whitespace and smart-quote differences', () => {
    expect(isQuoteGrounded('Secondary   vent\nflow on the non-drive-end', source)).toBe(true);
  });

  it('rejects a long quote with an elision rather than treating overlap as verbatim', () => {
    expect(
      isQuoteGrounded('Secondary vent flow on the dry gas seal measured 21 against threshold of 15', source)
    ).toBe(false);
  });

  it('rejects a quote made from real source words in a different order', () => {
    expect(
      isQuoteGrounded('OEM threshold measured 15 Nm³/h against vent flow of 21 Nm³/h', source)
    ).toBe(false);
  });

  it('rejects text that is not in the source', () => {
    expect(isQuoteGrounded('the seal was replaced during the last shutdown', source)).toBe(false);
  });

  it('rejects an empty quote', () => {
    expect(isQuoteGrounded('   ', source)).toBe(false);
  });

  it('requires short quotes to match exactly rather than by word overlap', () => {
    // Every word appears in the source, but not as this phrase — a short quote
    // must not pass on overlap alone.
    expect(isQuoteGrounded('flow threshold 15', source)).toBe(false);
  });
});

describe('enforceStatus', () => {
  it('forces INSUFFICIENT_EVIDENCE when nothing survived validation', () => {
    const result = enforceStatus('SUPPORTED', 0, 3, false, 0.9);
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.confidence).toBe(0);
    expect(result.warning).toMatch(/no citation survived/i);
  });

  it('does not warn when the model already said INSUFFICIENT_EVIDENCE', () => {
    expect(enforceStatus('INSUFFICIENT_EVIDENCE', 0, 0, false, 0.1).warning).toBeUndefined();
  });

  it('downgrades SUPPORTED to PARTIALLY_SUPPORTED when some citations were dropped', () => {
    const result = enforceStatus('SUPPORTED', 1, 3, false, 0.95);
    expect(result.status).toBe('PARTIALLY_SUPPORTED');
    expect(result.confidence).toBeLessThanOrEqual(0.7);
  });

  it('leaves SUPPORTED intact when every citation survived', () => {
    const result = enforceStatus('SUPPORTED', 3, 3, false, 0.9);
    expect(result.status).toBe('SUPPORTED');
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it('raises to CONFLICTING_EVIDENCE when a conflict exists', () => {
    const result = enforceStatus('SUPPORTED', 3, 3, true, 0.95);
    expect(result.status).toBe('CONFLICTING_EVIDENCE');
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });

  it('does not let a conflict rescue an answer with no surviving evidence', () => {
    expect(enforceStatus('SUPPORTED', 0, 2, true, 0.9).status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('clamps out-of-range confidence', () => {
    expect(enforceStatus('SUPPORTED', 1, 1, false, 5).confidence).toBe(1);
    expect(enforceStatus('SUPPORTED', 1, 1, false, Number.NaN).confidence).toBe(0);
  });
});

describe('computeEvidenceSupport', () => {
  const cite = (documentId: string): Citation => ({
    id: 'c',
    chunkId: 'k',
    documentId,
    citedContent: 'q',
    relevanceScore: 1,
  });

  it('is strong only when every citation verified across multiple sources', () => {
    expect(computeEvidenceSupport([cite('a'), cite('b')], 2).label).toBe('strong');
    // Same count, one source — well cited but narrowly.
    expect(computeEvidenceSupport([cite('a'), cite('a')], 2).label).toBe('moderate');
  });

  it('degrades as citations are dropped', () => {
    expect(computeEvidenceSupport([cite('a'), cite('b')], 3).label).toBe('moderate');
    expect(computeEvidenceSupport([cite('a')], 4).label).toBe('weak');
    expect(computeEvidenceSupport([], 3).label).toBe('none');
  });

  it('reports the counts it was derived from', () => {
    const support = computeEvidenceSupport([cite('a'), cite('b')], 4);
    expect(support).toMatchObject({ verified: 2, claimed: 4, documents: 2, verifiedRatio: 0.5 });
  });
});

describe('validateCitations', () => {
  const retrieved = [
    chunk('a', 'The maximum clean hold time is 72 hours before re-cleaning is required.'),
    chunk('b', 'Swab sampling must be performed at six locations at every changeover.'),
  ];

  it('keeps a citation whose quote is present in the cited chunk', () => {
    const result = validateCitations(
      [{ chunk_id: 'a', quote: 'maximum clean hold time is 72 hours', relevance: 0.9 }],
      retrieved,
      'SUPPORTED',
      0.9,
      []
    );

    expect(result.citations).toHaveLength(1);
    expect(result.evidenceStatus).toBe('SUPPORTED');
    expect(result.citations[0].documentId).toBe('doc-a');
    expect(result.citations[0].pageNumber).toBe(1);
  });

  it('drops a citation naming a chunk that was never retrieved', () => {
    const result = validateCitations(
      [{ chunk_id: 'nonexistent', quote: 'anything at all' }],
      retrieved,
      'SUPPORTED',
      0.9,
      []
    );

    expect(result.citations).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('unknown_chunk');
    expect(result.evidenceStatus).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('drops a citation whose quote does not appear in the chunk it names', () => {
    const result = validateCitations(
      [{ chunk_id: 'a', quote: 'the hold time is 120 hours' }],
      retrieved,
      'SUPPORTED',
      0.9,
      []
    );

    expect(result.rejected[0].reason).toBe('quote_not_in_chunk');
    expect(result.evidenceStatus).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('is not fooled by a real quote attributed to the wrong chunk', () => {
    // The text exists in the corpus — but in chunk b, not chunk a. Accepting
    // this would let a citation point a reviewer at the wrong document.
    const result = validateCitations(
      [{ chunk_id: 'a', quote: 'Swab sampling must be performed at six locations' }],
      retrieved,
      'SUPPORTED',
      0.9,
      []
    );

    expect(result.citations).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('quote_not_in_chunk');
  });

  it('collapses duplicate citations of one chunk', () => {
    const result = validateCitations(
      [
        { chunk_id: 'a', quote: 'maximum clean hold time is 72 hours' },
        { chunk_id: 'a', quote: 'before re-cleaning is required' },
      ],
      retrieved,
      'SUPPORTED',
      0.9,
      []
    );

    expect(result.citations).toHaveLength(1);
  });

  it('downgrades when only some citations survive', () => {
    const result = validateCitations(
      [
        { chunk_id: 'a', quote: 'maximum clean hold time is 72 hours' },
        { chunk_id: 'b', quote: 'a requirement that was never written down' },
      ],
      retrieved,
      'SUPPORTED',
      0.95,
      []
    );

    expect(result.citations).toHaveLength(1);
    expect(result.evidenceStatus).toBe('PARTIALLY_SUPPORTED');
    expect(result.warnings.join(' ')).toMatch(/1 of 2/);
  });

  it('reports CONFLICTING_EVIDENCE when conflicts are present and evidence survives', () => {
    const result = validateCitations(
      [{ chunk_id: 'a', quote: 'maximum clean hold time is 72 hours' }],
      retrieved,
      'SUPPORTED',
      0.9,
      [CONFLICT]
    );

    expect(result.evidenceStatus).toBe('CONFLICTING_EVIDENCE');
  });

  it('never reports SUPPORTED with zero citations, whatever the model claimed', () => {
    for (const claimed of ['SUPPORTED', 'PARTIALLY_SUPPORTED', 'CONFLICTING_EVIDENCE'] as const) {
      const result = validateCitations([], retrieved, claimed, 1, []);
      expect(result.evidenceStatus).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.confidence).toBe(0);
    }
  });
});
