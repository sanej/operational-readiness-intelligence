// Query-intent classification.
//
// General Q&A is the default. Readiness, conflict, and synthesis are
// specialisations that fire only when the question asks for them — a factual
// lookup answered as a readiness report buries the answer, and teaches the
// reader to skim the sections that matter when the question *is* about
// readiness.
//
// One case per intent, plus the mixed-signal case that caught a real miss.

import { describe, expect, it } from 'vitest';
import { classifyIntent } from '../intent';

describe('classifyIntent', () => {
  it.each([
    ['Which are the critical failure paths for C-101?', 'GENERAL_QA'],
    ['What is the OEM vent-flow alarm threshold?', 'GENERAL_QA'],
    ['Which corrective actions remain unresolved?', 'SYNTHESIS'],
    ['Are there conflicting SOP revisions for equipment cleaning?', 'CONFLICT_CHECK'],
    ['Is Compressor C-101 ready for planned maintenance?', 'READINESS_ASSESSMENT'],
  ])('%s -> %s', (question, expected) => {
    expect(classifyIntent(question).intent).toBe(expected);
  });

  it('prefers readiness when a question carries mixed signals', () => {
    // Both of these also read as synthesis ("remain open", "deviations"), but
    // the asker wants a decision, and the fuller structure is correct. The
    // second phrasing was misclassified as GENERAL_QA until a rule was added.
    expect(classifyIntent('Is C-101 ready, and which findings remain open?').intent).toBe(
      'READINESS_ASSESSMENT'
    );
    expect(
      classifyIntent('Can the batch be released given the open deviations?').intent
    ).toBe('READINESS_ASSESSMENT');
  });
});
