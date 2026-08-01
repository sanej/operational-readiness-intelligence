// Normalization: every input file becomes the same NormalizedDocument shape,
// whatever route it took to get there.
//
// Three routes:
//   - OCR       (pdf, images, docx, pptx) via Mistral OCR -> per-page Markdown
//   - direct    (md, txt) -> the text itself
//   - structured(csv, json) -> rendered to Markdown so headings/tables survive
//
// Downstream code never branches on file type again. Chunking, embedding and
// retrieval see one representation.

import type { MistralConfig } from '../config';
import type { ExtractionMethod } from '../types';
import { runOcr } from './ocr';

export interface NormalizedPage {
  pageNumber: number;
  markdown: string;
}

export interface NormalizedDocument {
  /** Full text, pages joined. */
  text: string;
  pages: NormalizedPage[];
  pageCount: number;
  extractionMethod: ExtractionMethod;
  /** YAML front matter, when present — the source of document metadata. */
  frontMatter?: Record<string, unknown>;
}

const OCR_TYPES = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'pptx']);
const TEXT_TYPES = new Set(['md', 'markdown', 'txt']);
const STRUCTURED_TYPES = new Set(['csv', 'json']);

export function detectFileType(fileName: string, mimeType = ''): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext) return ext === 'markdown' ? 'md' : ext;

  const mime = mimeType.toLowerCase();
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('json')) return 'json';
  if (mime.includes('csv')) return 'csv';
  if (mime.includes('markdown')) return 'md';
  if (mime.startsWith('text/')) return 'txt';
  return 'bin';
}

export function isSupportedFileType(fileType: string): boolean {
  return OCR_TYPES.has(fileType) || TEXT_TYPES.has(fileType) || STRUCTURED_TYPES.has(fileType);
}

export function mimeTypeFor(fileType: string): string {
  switch (fileType) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'md': return 'text/markdown';
    case 'txt': return 'text/plain';
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

/**
 * Parse YAML front matter.
 *
 * A deliberately small parser rather than a YAML dependency: the sample corpus
 * uses flat `key: value` pairs and simple `[a, b]` lists, and pulling a full
 * YAML engine into the Workers bundle to read that would be disproportionate.
 * Anything more complex belongs in the file body, not the header.
 */
export function parseFrontMatter(text: string): {
  frontMatter?: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { body: text };

  const frontMatter: Record<string, unknown> = {};

  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;

    const key = trimmed.slice(0, sep).trim();
    let raw = trimmed.slice(sep + 1).trim();

    // Strip surrounding quotes.
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }

    if (raw.startsWith('[') && raw.endsWith(']')) {
      frontMatter[key] = raw
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (raw === 'true' || raw === 'false') {
      frontMatter[key] = raw === 'true';
    } else if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
      frontMatter[key] = Number(raw);
    } else {
      frontMatter[key] = raw;
    }
  }

  return { frontMatter, body: text.slice(match[0].length) };
}

/** CSV to a Markdown table, so structure survives into chunking. */
function csvToMarkdown(csv: string): string {
  const rows = csv
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(splitCsvLine);

  if (rows.length === 0) return '';

  const header = rows[0];
  const body = rows.slice(1);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Handles quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function jsonToMarkdown(json: string): string {
  const render = (value: unknown, depth: number): string => {
    const pad = '  '.repeat(depth);
    if (value === null || value === undefined) return `${pad}—`;
    if (Array.isArray(value)) {
      return value.map((v) => `${pad}- ${render(v, 0).trim()}`).join('\n');
    }
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .map(([k, v]) =>
          typeof v === 'object' && v !== null
            ? `${pad}**${k}**\n${render(v, depth + 1)}`
            : `${pad}**${k}**: ${String(v)}`
        )
        .join('\n');
    }
    return `${pad}${String(value)}`;
  };

  try {
    return render(JSON.parse(json), 0);
  } catch {
    return json;
  }
}

/**
 * Turn raw bytes into a NormalizedDocument, choosing the extraction route
 * from the file type.
 */
export async function normalizeDocument(
  content: ArrayBuffer | Uint8Array,
  fileName: string,
  mimeType: string,
  config: MistralConfig
): Promise<NormalizedDocument> {
  const fileType = detectFileType(fileName, mimeType);

  if (!isSupportedFileType(fileType)) {
    throw new Error(
      `Unsupported file type "${fileType}". Supported: ` +
        `${[...OCR_TYPES, ...TEXT_TYPES, ...STRUCTURED_TYPES].join(', ')}`
    );
  }

  if (OCR_TYPES.has(fileType)) {
    const ocr = await runOcr(content, mimeType || mimeTypeFor(fileType), config);
    return {
      text: ocr.pages.map((p) => p.markdown).join('\n\n'),
      pages: ocr.pages.map((p) => ({ pageNumber: p.pageNumber, markdown: p.markdown })),
      pageCount: ocr.pageCount,
      extractionMethod: 'ocr',
    };
  }

  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  const raw = new TextDecoder().decode(bytes);

  if (TEXT_TYPES.has(fileType)) {
    const { frontMatter, body } = parseFrontMatter(raw);
    return {
      text: body,
      pages: [{ pageNumber: 1, markdown: body }],
      pageCount: 1,
      extractionMethod: 'direct',
      frontMatter,
    };
  }

  // structured
  const rendered = fileType === 'csv' ? csvToMarkdown(raw) : jsonToMarkdown(raw);
  return {
    text: rendered,
    pages: [{ pageNumber: 1, markdown: rendered }],
    pageCount: 1,
    extractionMethod: 'structured',
  };
}
