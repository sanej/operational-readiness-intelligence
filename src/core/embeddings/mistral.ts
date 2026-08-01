// Mistral embeddings (mistral-embed, 1024-d).
//
// The API key is passed in, never read from module scope, so this works
// identically on Workers and in the Node CLI.

import { MISTRAL_API_BASE, type MistralConfig } from '../config';

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  promptTokens?: number;
}

/** Mistral rejects oversized batches; stay well under the limit. */
const MAX_BATCH = 64;

export class EmbeddingService {
  constructor(private readonly config: MistralConfig) {}

  async embedOne(text: string): Promise<number[]> {
    const { embeddings } = await this.embed([text]);
    return embeddings[0];
  }

  /**
   * Embed many texts, batching transparently.
   *
   * Order is preserved: results are re-sorted by the API's returned index, so
   * callers can zip embeddings back onto their inputs positionally.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { embeddings: [], model: this.config.embedModel };
    }

    const all: number[][] = [];
    let promptTokens = 0;

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const res = await this.callApi(batch);
      all.push(...res.embeddings);
      promptTokens += res.promptTokens ?? 0;
    }

    return { embeddings: all, model: this.config.embedModel, promptTokens };
  }

  private async callApi(texts: string[]): Promise<EmbedResult> {
    const response = await fetchWithRetry(`${MISTRAL_API_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.embedModel,
        input: texts,
        encoding_format: 'float',
      }),
    });

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
      usage?: { prompt_tokens?: number };
    };

    const sorted = [...data.data].sort((a, b) => a.index - b.index);

    // A dimension mismatch would silently poison the index; fail loudly.
    const dims = sorted[0]?.embedding.length;
    if (dims !== undefined && dims !== this.config.embedDimensions) {
      throw new Error(
        `Embedding dimension mismatch: got ${dims}, expected ${this.config.embedDimensions}. ` +
          `The Vectorize index must be created with --dimensions=${this.config.embedDimensions}.`
      );
    }

    return {
      embeddings: sorted.map((d) => d.embedding),
      model: data.model,
      promptTokens: data.usage?.prompt_tokens,
    };
  }
}

/**
 * Retry on transient failures only.
 *
 * 429 and 5xx are worth retrying; a 400 or 401 will fail identically every
 * time and should surface immediately rather than after three backoffs.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text();
      const error = new Error(`Mistral API ${response.status} ${response.statusText}: ${body}`);

      if (!retryable || attempt === maxRetries) throw error;
      lastError = error;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
  }

  throw lastError ?? new Error('Request failed');
}
