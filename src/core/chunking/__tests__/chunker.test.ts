// Chunking tests.
//
// The property that matters is provenance: a chunk must be attributable to the
// section it came from, because that attribution is what a citation shows a
// reviewer. A chunk with the wrong heading path points them at the wrong part
// of the procedure.

import { describe, expect, it } from 'vitest';
import { chunkPages } from '../chunker';
import type { ChunkingConfig } from '../../config';

const config: ChunkingConfig = {
  targetTokens: 120,
  overlapTokens: 20,
  maxTokens: 170,
  minTokens: 4,
};

describe('chunkPages', () => {
  it('splits on headings and records the heading path', () => {
    const chunks = chunkPages(
      [
        {
          pageNumber: 1,
          markdown: [
            '# SP-204 Energy Isolation',
            '',
            '## 2. Isolation Requirements',
            '',
            '### 2.1 Electrical Isolation',
            'Rack out the driver breaker at MCC-4B and apply a personal lock.',
            '',
            '### 2.2 Process Isolation',
            'Close and lock the suction isolation valve XV-C101-01.',
          ].join('\n'),
        },
      ],
      { ...config, targetTokens: 20, maxTokens: 40 }
    );

    const paths = chunks.map((c) => c.provenance.headingPath);
    expect(paths.some((p) => p?.includes('2.1 Electrical Isolation'))).toBe(true);
    expect(paths.some((p) => p?.includes('2.2 Process Isolation'))).toBe(true);

    // The heading path is a breadcrumb, not just the leaf.
    const electrical = chunks.find((c) => c.provenance.headingPath?.includes('2.1'));
    expect(electrical?.provenance.headingPath).toMatch(/SP-204 Energy Isolation/);
  });

  it('keeps the heading line in the chunk body', () => {
    // The heading often carries the only equipment tag or procedure number in
    // the section; dropping it would remove that from the embedded text.
    const chunks = chunkPages(
      [{ pageNumber: 1, markdown: '## 4.1 Pre-Start Checklist\nConfirm lube oil level is nominal.' }],
      config
    );

    expect(chunks[0].content).toContain('4.1 Pre-Start Checklist');
  });

  it('attributes a merged chunk to the deepest shared heading, not the first', () => {
    const chunks = chunkPages(
      [
        {
          pageNumber: 1,
          markdown: [
            '# Manual',
            '## 2. Isolation',
            '### 2.1 First',
            'Short body one.',
            '',
            '### 2.2 Second',
            'Short body two.',
          ].join('\n'),
        },
      ],
      // Large target so 2.1 and 2.2 merge into a single chunk.
      { ...config, targetTokens: 500, maxTokens: 800 }
    );

    const merged = chunks.find((c) => c.content.includes('Short body one') && c.content.includes('Short body two'));
    expect(merged).toBeDefined();
    // Reporting this as "2.1 First" would point a reviewer at half the content.
    expect(merged!.provenance.headingPath).toBe('Manual > 2. Isolation');
  });

  it('never merges content across pages', () => {
    const chunks = chunkPages(
      [
        { pageNumber: 1, markdown: '## Section A\nContent on the first page.' },
        { pageNumber: 2, markdown: '## Section B\nContent on the second page.' },
      ],
      { ...config, targetTokens: 500, maxTokens: 800 }
    );

    for (const chunk of chunks) {
      const onPageOne = chunk.content.includes('first page');
      const onPageTwo = chunk.content.includes('second page');
      expect(onPageOne && onPageTwo).toBe(false);
    }
  });

  it('never merges across top-level sections', () => {
    const chunks = chunkPages(
      [
        {
          pageNumber: 1,
          markdown: [
            '# Doc',
            '## 3. Gas Testing',
            'Oxygen must be between 19.5 and 23.5 percent.',
            '',
            '## 4. Permits',
            'A general work permit is required.',
          ].join('\n'),
        },
      ],
      { ...config, targetTokens: 500, maxTokens: 800 }
    );

    for (const chunk of chunks) {
      const hasGas = chunk.content.includes('Oxygen must be');
      const hasPermit = chunk.content.includes('general work permit');
      expect(hasGas && hasPermit).toBe(false);
    }
  });

  it('splits an oversized section into windows that stay within maxTokens', () => {
    const body = Array.from({ length: 60 }, (_, i) => `Step ${i}: perform the required check.`).join('\n\n');
    const chunks = chunkPages([{ pageNumber: 1, markdown: `## Long Section\n${body}` }], config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(config.maxTokens);
      // Provenance survives the split.
      expect(chunk.provenance.headingPath).toContain('Long Section');
    }
  });

  it('handles content with no headings at all', () => {
    const chunks = chunkPages(
      [{ pageNumber: 1, markdown: 'A plain paragraph with no structure whatsoever.' }],
      config
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('plain paragraph');
  });

  it('drops empty content', () => {
    expect(chunkPages([{ pageNumber: 1, markdown: '\n\n   \n' }], config)).toHaveLength(0);
  });
});
