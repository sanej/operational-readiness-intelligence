// Runtime configuration, read from Worker bindings or process.env.
//
// The Mistral API key is always passed in explicitly rather than read from
// module scope. Proofcase's OCR client read process.env at import time, which
// is undefined on Workers — the bug is avoided here by construction.

import type { D1Database, R2Bucket, VectorizeIndex } from '@cloudflare/workers-types';

export interface OriBindings {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  MISTRAL_API_KEY: string;
  MISTRAL_EMBED_MODEL?: string;
  MISTRAL_CHAT_MODEL?: string;
  MISTRAL_OCR_MODEL?: string;
  CHUNK_TARGET_TOKENS?: string;
  CHUNK_OVERLAP_TOKENS?: string;
  RETRIEVAL_TOP_K?: string;
}

export interface ChunkingConfig {
  targetTokens: number;
  overlapTokens: number;
  maxTokens: number;
  minTokens: number;
}

export interface MistralConfig {
  apiKey: string;
  embedModel: string;
  chatModel: string;
  ocrModel: string;
  embedDimensions: number;
}

export interface OriConfig {
  mistral: MistralConfig;
  chunking: ChunkingConfig;
  retrieval: { defaultTopK: number };
}

/** mistral-embed is fixed at 1024 dimensions; the Vectorize index matches. */
export const EMBED_DIMENSIONS = 1024;

export const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';

function intFrom(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createConfig(env: Partial<OriBindings>): OriConfig {
  const apiKey = env.MISTRAL_API_KEY ?? '';

  if (!apiKey) {
    throw new Error(
      'MISTRAL_API_KEY is not set. Locally, put it in .dev.vars; ' +
        'in production use `npx wrangler secret put MISTRAL_API_KEY`.'
    );
  }

  const targetTokens = intFrom(env.CHUNK_TARGET_TOKENS, 512);
  const overlapTokens = intFrom(env.CHUNK_OVERLAP_TOKENS, 100);

  return {
    mistral: {
      apiKey,
      embedModel: env.MISTRAL_EMBED_MODEL || 'mistral-embed',
      chatModel: env.MISTRAL_CHAT_MODEL || 'mistral-large-latest',
      ocrModel: env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
      embedDimensions: EMBED_DIMENSIONS,
    },
    chunking: {
      targetTokens,
      overlapTokens,
      // Headroom above target so a section that slightly overruns stays whole
      // rather than being split mid-procedure.
      maxTokens: Math.round(targetTokens * 1.4),
      minTokens: 32,
    },
    retrieval: { defaultTopK: intFrom(env.RETRIEVAL_TOP_K, 8) },
  };
}

/**
 * Approximate token count.
 *
 * Deliberately not a real BPE tokenizer: those ship native binaries or large
 * WASM blobs that complicate the Workers bundle, and chunk sizing only needs
 * to be consistent, not exact. Word-and-punctuation counting tracks Mistral's
 * tokenizer closely enough for budgeting.
 */
export function countTokens(text: string): number {
  return (text.match(/\b\w+\b|[^\w\s]/g) || []).length;
}
