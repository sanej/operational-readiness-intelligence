import { describe, expect, it } from 'vitest';
import { mergeEvidenceConflicts } from '../../ask';
import type { EvidenceConflict } from '../../types';

function conflict(
  kind: EvidenceConflict['kind'],
  description: string,
  documentIds: string[],
  chunkIds: string[]
): EvidenceConflict {
  return { kind, description, documentIds, chunkIds };
}

describe('mergeEvidenceConflicts', () => {
  it('combines a semantic explanation with the same structural revision conflict', () => {
    const result = mergeEvidenceConflicts(
      [conflict('revision', 'Two active revisions.', ['a', 'b'], ['a1', 'b1'])],
      [conflict('substantive', 'Rev 6 requires spading; Rev 7 permits DBB.', ['b', 'a'], ['a2', 'b2'])]
    );

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('revision');
    expect(result[0].description).toContain('Content difference:');
    expect(result[0].chunkIds).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('keeps unrelated substantive conflicts separate', () => {
    const result = mergeEvidenceConflicts(
      [conflict('revision', 'Two active revisions.', ['a', 'b'], ['a1', 'b1'])],
      [conflict('substantive', 'Inspection and permit disagree.', ['c', 'd'], ['c1', 'd1'])]
    );

    expect(result).toHaveLength(2);
  });
});
