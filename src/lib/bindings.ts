// Runtime access to Cloudflare bindings inside Next.js route handlers.
//
// Fails loudly rather than degrading to a stub. A silent fallback would let
// the app appear to work while writing nothing to R2, D1, or Vectorize — the
// worst possible failure for a system whose entire value is that its answers
// are backed by real indexed evidence.

import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { OriBindings } from '@/core/config';

export class MissingBindingsError extends Error {
  constructor(detail: string) {
    super(
      `Cloudflare bindings unavailable: ${detail}. ` +
        `Run the app with "npm run preview" (wrangler) rather than "next dev", ` +
        `and confirm wrangler.toml declares DB, R2_BUCKET, and VECTORIZE.`
    );
    this.name = 'MissingBindingsError';
  }
}

export function getBindings(): OriBindings {
  const { env } = getCloudflareContext();

  if (!env) throw new MissingBindingsError('no Cloudflare context for this request');

  const typed = env as unknown as OriBindings;

  const missing = (['DB', 'R2_BUCKET', 'VECTORIZE'] as const).filter(
    (key) => !(env as unknown as Record<string, unknown>)[key]
  );
  if (missing.length > 0) throw new MissingBindingsError(`missing ${missing.join(', ')}`);

  if (!typed.MISTRAL_API_KEY) {
    throw new MissingBindingsError(
      'MISTRAL_API_KEY is not set (use .dev.vars locally, or `wrangler secret put MISTRAL_API_KEY`)'
    );
  }

  return typed;
}

/** Map an error to a response shape the UI can render without leaking internals. */
export function toApiError(error: unknown): { message: string; status: number } {
  if (error instanceof MissingBindingsError) {
    return { message: error.message, status: 503 };
  }

  const message = error instanceof Error ? error.message : String(error);

  // Surface Mistral rate limiting distinctly — it is transient and retryable,
  // and telling the user to retry is more useful than a generic 500.
  if (/\b429\b/.test(message)) {
    return { message: 'Mistral API rate limit reached. Retry in a moment.', status: 429 };
  }

  return { message, status: 500 };
}
