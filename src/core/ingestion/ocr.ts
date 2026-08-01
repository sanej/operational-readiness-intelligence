// Mistral OCR (mistral-ocr-latest).
//
// Used for PDFs, images, and office documents. Mistral OCR returns per-page
// Markdown, which preserves headings and tables — that structure is what
// makes structure-aware chunking possible downstream, so it is kept rather
// than flattened to plain text.

import { MISTRAL_API_BASE, type MistralConfig } from '../config';
import { fetchWithRetry } from '../embeddings/mistral';

export interface OcrPage {
  pageNumber: number;
  /** Markdown, preserving headings and tables. */
  markdown: string;
}

export interface OcrResult {
  pages: OcrPage[];
  pageCount: number;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked to avoid blowing the argument limit on large files.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Run Mistral OCR over a document.
 *
 * Mistral's OCR endpoint takes a document URL; a data: URI carries the bytes
 * inline, which avoids needing a public URL for the file.
 */
export async function runOcr(
  content: ArrayBuffer | Uint8Array,
  mimeType: string,
  config: MistralConfig
): Promise<OcrResult> {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  const dataUri = `data:${mimeType};base64,${toBase64(bytes)}`;

  const isImage = mimeType.startsWith('image/');
  const document = isImage
    ? { type: 'image_url', image_url: dataUri }
    : { type: 'document_url', document_url: dataUri };

  const response = await fetchWithRetry(`${MISTRAL_API_BASE}/ocr`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ocrModel,
      document,
      include_image_base64: false,
    }),
  });

  const data = (await response.json()) as {
    pages?: Array<{ index?: number; markdown?: string; text?: string }>;
  };

  const pages: OcrPage[] = (data.pages ?? []).map((p, i) => ({
    // Mistral's page index is 0-based; humans cite pages from 1.
    pageNumber: (p.index ?? i) + 1,
    markdown: p.markdown ?? p.text ?? '',
  }));

  if (pages.length === 0) {
    throw new Error('Mistral OCR returned no pages');
  }

  return { pages, pageCount: pages.length };
}
