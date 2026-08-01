// Structure-aware chunking.
//
// Operational documents are hierarchical: a procedure has sections, a section
// has steps, and a citation is only actionable if it names the section it came
// from ("Section 4.2 Electrical Isolation", not "page 3"). So chunking splits
// on Markdown heading boundaries first and only falls back to token windows
// when a single section is too large to embed whole.
//
// Each chunk carries the heading path of its enclosing sections, which is what
// lets the UI show "Isolation > Electrical > LOTO" beside a citation.

import { countTokens, type ChunkingConfig } from '../config';
import type { ChunkProvenance } from '../types';

export interface RawChunk {
  content: string;
  provenance: ChunkProvenance;
  tokenCount: number;
}

interface Section {
  /** Heading text, or undefined for content before the first heading. */
  heading?: string;
  /** Enclosing headings, outermost first. */
  path: string[];
  level: number;
  lines: string[];
  pageNumber: number;
}

interface PageInput {
  pageNumber: number;
  markdown: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/**
 * Split pages into sections following the Markdown heading hierarchy.
 *
 * Page boundaries never merge: a section continuing across a page break
 * becomes two sections, each attributed to its own page, so a citation's page
 * number is always the page the quoted text is actually on.
 */
function splitIntoSections(pages: PageInput[]): Section[] {
  const sections: Section[] = [];

  for (const page of pages) {
    // Stack of open headings; index i holds the most recent heading at level i+1.
    const stack: Array<{ level: number; text: string }> = [];
    let current: Section = { path: [], level: 0, lines: [], pageNumber: page.pageNumber };

    const flush = () => {
      if (current.lines.some((l) => l.trim())) sections.push(current);
    };

    for (const line of page.markdown.split(/\r?\n/)) {
      const match = HEADING.exec(line);

      if (!match) {
        current.lines.push(line);
        continue;
      }

      flush();

      const level = match[1].length;
      const text = match[2].trim();

      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });

      current = {
        heading: text,
        path: stack.map((s) => s.text),
        level,
        // The heading is part of the chunk: it is often the only place the
        // equipment tag or procedure number appears, and dropping it would
        // strip that from the embedded text.
        lines: [line],
        pageNumber: page.pageNumber,
      };
    }

    flush();
  }

  return sections;
}

/**
 * Split oversized text into overlapping token windows, breaking on paragraph
 * boundaries where possible so a step is not severed mid-sentence.
 */
function splitByTokens(
  text: string,
  config: ChunkingConfig
): Array<{ content: string; tokenCount: number }> {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const out: Array<{ content: string; tokenCount: number }> = [];

  let buffer: string[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const content = buffer.join('\n\n');
    out.push({ content, tokenCount: bufferTokens });

    // Carry the tail of this window into the next, so a fact spanning the
    // boundary is retrievable from either side.
    const overlap: string[] = [];
    let overlapTokens = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      const t = countTokens(buffer[i]);
      if (overlapTokens + t > config.overlapTokens) break;
      overlap.unshift(buffer[i]);
      overlapTokens += t;
    }
    buffer = overlap;
    bufferTokens = overlapTokens;
  };

  for (const paragraph of paragraphs) {
    const tokens = countTokens(paragraph);

    // A single paragraph over the limit: hard-split on sentences.
    if (tokens > config.maxTokens) {
      flush();
      if (buffer.length > 0) {
        out.push({ content: buffer.join('\n\n'), tokenCount: bufferTokens });
        buffer = [];
        bufferTokens = 0;
      }

      const sentences = paragraph.match(/[^.!?]+[.!?]+|\S+$/g) ?? [paragraph];
      let sentenceBuf: string[] = [];
      let sentenceTokens = 0;

      for (const sentence of sentences) {
        const st = countTokens(sentence);
        if (sentenceTokens + st > config.targetTokens && sentenceBuf.length > 0) {
          out.push({ content: sentenceBuf.join(' ').trim(), tokenCount: sentenceTokens });
          sentenceBuf = [];
          sentenceTokens = 0;
        }
        sentenceBuf.push(sentence.trim());
        sentenceTokens += st;
      }
      if (sentenceBuf.length > 0) {
        out.push({ content: sentenceBuf.join(' ').trim(), tokenCount: sentenceTokens });
      }
      continue;
    }

    if (bufferTokens + tokens > config.targetTokens && buffer.length > 0) flush();

    buffer.push(paragraph);
    bufferTokens += tokens;
  }

  if (buffer.length > 0) {
    out.push({ content: buffer.join('\n\n'), tokenCount: bufferTokens });
  }

  return out;
}

/** The longest heading path shared by every section in a merged chunk. */
function commonPrefix(paths: string[][]): string[] {
  if (paths.length === 0) return [];

  const shortest = Math.min(...paths.map((p) => p.length));
  const prefix: string[] = [];

  for (let i = 0; i < shortest; i++) {
    const candidate = paths[0][i];
    if (paths.every((p) => p[i] === candidate)) prefix.push(candidate);
    else break;
  }

  return prefix;
}

/**
 * Produce retrieval chunks from normalized pages.
 *
 * Small adjacent sections are merged up to the target size so a two-line
 * subsection does not become its own near-contextless chunk; large sections
 * are windowed. Either way every chunk keeps the heading path and page of
 * the section it came from.
 */
export function chunkPages(pages: PageInput[], config: ChunkingConfig): RawChunk[] {
  const sections = splitIntoSections(pages);
  const chunks: RawChunk[] = [];

  let pending: Section[] = [];
  let pendingTokens = 0;

  const flushPending = () => {
    if (pending.length === 0) return;

    const content = pending.map((s) => s.lines.join('\n').trim()).join('\n\n');
    const first = pending[0];

    // When a chunk spans several sections, attribute it to the deepest heading
    // they share rather than to the first one. Reporting a chunk covering
    // §2.1–§2.3 as "§2.1" would point a reviewer at the wrong subsection; the
    // common ancestor ("§2 Isolation Requirements") is the honest answer.
    const path = pending.length === 1 ? first.path : commonPrefix(pending.map((s) => s.path));

    chunks.push({
      content,
      provenance: {
        pageNumber: first.pageNumber,
        section: path.length > 0 ? path[path.length - 1] : first.heading,
        headingPath: path.length > 0 ? path.join(' > ') : undefined,
      },
      tokenCount: pendingTokens,
    });

    pending = [];
    pendingTokens = 0;
  };

  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (!text) continue;

    const tokens = countTokens(text);

    if (tokens > config.maxTokens) {
      flushPending();

      for (const piece of splitByTokens(text, config)) {
        chunks.push({
          content: piece.content,
          provenance: {
            pageNumber: section.pageNumber,
            section: section.heading,
            headingPath: section.path.length > 0 ? section.path.join(' > ') : undefined,
          },
          tokenCount: piece.tokenCount,
        });
      }
      continue;
    }

    // Never merge across pages: it would make the chunk's page number a lie.
    const crossesPage =
      pending.length > 0 && pending[0].pageNumber !== section.pageNumber;

    // Never merge across top-level sections. Packing "§3 Gas Testing" together
    // with "§4 Permits" purely because both are short produces a chunk that
    // cannot be cited precisely, and in these documents a major section is
    // exactly the unit a reviewer needs pointed at.
    const crossesTopLevelSection =
      pending.length > 0 &&
      section.level > 0 &&
      pending[0].path[0] !== undefined &&
      section.path[0] !== undefined &&
      // Compare the outermost heading below the document title (H1).
      (pending[0].path[1] ?? pending[0].path[0]) !== (section.path[1] ?? section.path[0]);

    if (crossesPage || crossesTopLevelSection || pendingTokens + tokens > config.targetTokens) {
      flushPending();
    }

    pending.push(section);
    pendingTokens += tokens;
  }

  flushPending();

  return chunks.filter((c) => c.content.trim().length > 0 && c.tokenCount >= config.minTokens);
}
