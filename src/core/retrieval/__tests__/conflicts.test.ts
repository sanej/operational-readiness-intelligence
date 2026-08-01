// Structural conflict detection.
//
// This catches the case a model reading chunk-by-chunk reliably misses: two
// documents that are competing revisions of the same procedure, both presented
// as current. Getting this wrong in either direction is costly — a missed
// conflict lets an answer pick a side silently, and a spurious one trains the
// reviewer to ignore the warning.

import { describe, expect, it } from 'vitest';
import { detectRevisionConflicts } from '../retrieve';
import type { RetrievedChunk } from '../../types';

function chunk(id: string, documentId: string, revision?: string): RetrievedChunk {
  return {
    chunkId: id,
    documentId,
    content: `content of ${id}`,
    score: 0.8,
    adjustedScore: 0.8,
    provenance: {},
    revision,
    metadata: {},
  };
}

type DocInfo = {
  documentType?: string;
  revision?: string;
  status?: string;
  title?: string;
  subject?: string;
};

function docs(entries: Record<string, DocInfo>): Map<string, DocInfo> {
  return new Map(Object.entries(entries));
}

describe('detectRevisionConflicts', () => {
  it('flags two active revisions of the same document', () => {
    const conflicts = detectRevisionConflicts(
      [chunk('c1', 'doc-rev6'), chunk('c2', 'doc-rev7')],
      docs({
        'doc-rev6': {
          documentType: 'safety_procedure',
          revision: 'Rev 6',
          status: 'active',
          title: 'SP-204',
          subject: 'SP-204',
        },
        'doc-rev7': {
          documentType: 'safety_procedure',
          revision: 'Rev 7',
          status: 'active',
          title: 'SP-204 (Revised)',
          subject: 'SP-204',
        },
      })
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('revision');
    expect(conflicts[0].documentIds.sort()).toEqual(['doc-rev6', 'doc-rev7']);
    expect(conflicts[0].description).toMatch(/Rev 6/);
    expect(conflicts[0].description).toMatch(/Rev 7/);
  });

  it('does not flag when one revision is marked superseded', () => {
    // The corpus is telling us which one wins; that is not a conflict.
    const conflicts = detectRevisionConflicts(
      [chunk('c1', 'doc-old'), chunk('c2', 'doc-new')],
      docs({
        'doc-old': {
          documentType: 'sop',
          revision: 'Rev 2',
          status: 'superseded',
          subject: 'SOP-CL-004',
        },
        'doc-new': {
          documentType: 'sop',
          revision: 'Rev 3',
          status: 'active',
          subject: 'SOP-CL-004',
        },
      })
    );

    expect(conflicts).toHaveLength(0);
  });

  it('does not flag different documents that merely share an asset', () => {
    // An operating procedure and a safety procedure about the same compressor
    // are not competing revisions of anything.
    const conflicts = detectRevisionConflicts(
      [chunk('c1', 'doc-op'), chunk('c2', 'doc-sp')],
      docs({
        'doc-op': {
          documentType: 'operating_procedure',
          revision: 'Rev 4',
          status: 'active',
          subject: 'OP-101',
        },
        'doc-sp': {
          documentType: 'safety_procedure',
          revision: 'Rev 6',
          status: 'active',
          subject: 'SP-204',
        },
      })
    );

    expect(conflicts).toHaveLength(0);
  });

  it('does not flag two chunks from the same document', () => {
    const conflicts = detectRevisionConflicts(
      [chunk('c1', 'doc-a'), chunk('c2', 'doc-a')],
      docs({
        'doc-a': {
          documentType: 'sop',
          revision: 'Rev 3',
          status: 'active',
          subject: 'SOP-CL-004',
        },
      })
    );

    expect(conflicts).toHaveLength(0);
  });

  it('does not flag documents of the same type about different subjects', () => {
    const conflicts = detectRevisionConflicts(
      [chunk('c1', 'doc-a'), chunk('c2', 'doc-b')],
      docs({
        'doc-a': { documentType: 'sop', revision: 'Rev 1', status: 'active', subject: 'SOP-CL-004' },
        'doc-b': { documentType: 'sop', revision: 'Rev 2', status: 'active', subject: 'SOP-MX-011' },
      })
    );

    expect(conflicts).toHaveLength(0);
  });

  it('ignores documents with no revision or no type', () => {
    const conflicts = detectRevisionConflicts(
      [chunk('c1', 'doc-a'), chunk('c2', 'doc-b')],
      docs({
        'doc-a': { documentType: 'sop', status: 'active', subject: 'SOP-CL-004' },
        'doc-b': { revision: 'Rev 2', status: 'active', subject: 'SOP-CL-004' },
      })
    );

    expect(conflicts).toHaveLength(0);
  });

  it('collects every chunk on each side of the conflict', () => {
    const conflicts = detectRevisionConflicts(
      [
        chunk('c1', 'doc-rev6'),
        chunk('c2', 'doc-rev6'),
        chunk('c3', 'doc-rev7'),
      ],
      docs({
        'doc-rev6': { documentType: 'safety_procedure', revision: 'Rev 6', status: 'active', subject: 'SP-204' },
        'doc-rev7': { documentType: 'safety_procedure', revision: 'Rev 7', status: 'active', subject: 'SP-204' },
      })
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].chunkIds.sort()).toEqual(['c1', 'c2', 'c3']);
  });
});
