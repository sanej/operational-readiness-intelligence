// Tests for parsing the model's structured output.
//
// The governing rule: a malformed response must never become a confident
// answer. Every failure path degrades to INSUFFICIENT_EVIDENCE with no
// citations, which the validator then holds at that level.

import { describe, expect, it } from 'vitest';
import { parseModelAnswer, stripInlineChunkRefs } from '../generate';

function json(value: unknown): string {
  return JSON.stringify(value);
}

const WELL_FORMED = {
  answer: '## Summary\n\nThe procedure requires isolation.',
  evidence_status: 'SUPPORTED',
  confidence: 0.9,
  citations: [{ chunk_id: 'chk_1', quote: 'requires isolation', relevance: 0.8 }],
  missing_evidence: [],
  conflicts: [],
  verification_required: ['Confirm the isolation certificate is signed.'],
};

describe('parseModelAnswer', () => {
  it('parses a well-formed response', () => {
    const result = parseModelAnswer(json(WELL_FORMED), 5);
    expect(result.evidence_status).toBe('SUPPORTED');
    expect(result.citations).toHaveLength(1);
    expect(result.answer).toContain('requires isolation');
  });

  it('flattens an object-valued answer to Markdown', () => {
    // The model sometimes honours the requested answer structure literally and
    // returns an object keyed by section. That is a reasonable reading of the
    // instruction, so it should not lose the answer.
    const result = parseModelAnswer(
      json({
        ...WELL_FORMED,
        answer: {
          summary_of_what_the_evidence_shows: 'Two revisions disagree.',
          missing_evidence: ['The hold-time study.'],
        },
      }),
      5
    );

    expect(result.answer).toContain('## Summary of what the evidence shows');
    expect(result.answer).toContain('Two revisions disagree.');
    expect(result.answer).toContain('- The hold-time study.');
    expect(result.evidence_status).toBe('SUPPORTED');
  });

  it('extracts JSON wrapped in prose or a code fence', () => {
    const wrapped = `Here is the result:\n\`\`\`json\n${json(WELL_FORMED)}\n\`\`\``;
    expect(parseModelAnswer(wrapped, 5).evidence_status).toBe('SUPPORTED');
  });

  it('degrades to INSUFFICIENT_EVIDENCE on unparseable output', () => {
    const result = parseModelAnswer('this is not JSON at all', 4);
    expect(result.evidence_status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.citations).toHaveLength(0);
    expect(result.confidence).toBe(0);
    expect(result.verification_required.length).toBeGreaterThan(0);
  });

  it('degrades on an invalid evidence status rather than passing it through', () => {
    const result = parseModelAnswer(json({ ...WELL_FORMED, evidence_status: 'APPROVED' }), 4);
    expect(result.evidence_status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.citations).toHaveLength(0);
  });

  it('salvages the answer text when only the metadata is malformed', () => {
    const result = parseModelAnswer(
      json({ ...WELL_FORMED, answer: 'The seal is degrading.', confidence: 'very high' }),
      4
    );

    // The prose survives, but it carries no unearned status or citations.
    expect(result.answer).toContain('The seal is degrading.');
    expect(result.evidence_status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.citations).toHaveLength(0);
  });

  it('defaults optional arrays so callers never see undefined', () => {
    const result = parseModelAnswer(
      json({ answer: 'text', evidence_status: 'SUPPORTED', confidence: 0.5 }),
      3
    );
    expect(result.citations).toEqual([]);
    expect(result.missing_evidence).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.verification_required).toEqual([]);
  });
});

describe('stripInlineChunkRefs', () => {
  it('removes markdown-linked chunk ids', () => {
    expect(stripInlineChunkRefs('Rev 3 specifies 72 hours ([chk_d478](#)).')).toBe(
      'Rev 3 specifies 72 hours.'
    );
  });

  it('removes bare and backticked chunk ids', () => {
    expect(stripInlineChunkRefs('See chk_9615469f8164e24d for detail.')).toBe('See for detail.');
    expect(stripInlineChunkRefs('Value is 21 Nm³/h (`chk_abc123`).')).toBe('Value is 21 Nm³/h.');
  });

  it('leaves ordinary prose untouched', () => {
    const text = '## Summary\n\nSP-204 Rev 6 requires spading at both flanges.';
    expect(stripInlineChunkRefs(text)).toBe(text);
  });
});
