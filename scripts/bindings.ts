// Node-side access to the same Cloudflare bindings the Worker uses.
//
// wrangler's getPlatformProxy reads wrangler.toml and returns live D1, R2, and
// Vectorize objects implementing the same interfaces as the Worker runtime.
// Because those bindings are declared `remote = true`, the CLI operates on the
// same D1 database, R2 bucket, and Vectorize index as the deployed app — so
// `npm run ingest` and a web upload genuinely share one pipeline and one
// corpus, rather than the CLI maintaining a parallel local copy.

import { getPlatformProxy } from 'wrangler';
import type { OriBindings } from '../src/core/config';

export interface CliContext {
  bindings: OriBindings;
  dispose: () => Promise<void>;
}

export async function getCliBindings(): Promise<CliContext> {
  // Bindings declared `remote = true` in wrangler.toml connect to the real
  // Cloudflare resources, so the CLI reads and writes the same D1 database,
  // R2 bucket, and Vectorize index as the deployed Worker.
  const proxy = await getPlatformProxy<OriBindings>({ configPath: 'wrangler.toml' });

  const env = proxy.env;

  // .dev.vars is loaded by `tsx --env-file`, but getPlatformProxy also surfaces
  // it. Prefer whichever is present so the CLI works either way.
  const apiKey = env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || '';

  if (!apiKey) {
    await proxy.dispose();
    throw new Error(
      'MISTRAL_API_KEY is not set. Add it to .dev.vars in the project root:\n' +
        '  MISTRAL_API_KEY="your-key"'
    );
  }

  const missing = (['DB', 'R2_BUCKET', 'VECTORIZE'] as const).filter((k) => !env[k]);
  if (missing.length > 0) {
    await proxy.dispose();
    throw new Error(
      `Cloudflare bindings unavailable: ${missing.join(', ')}. ` +
        `Run \`npx wrangler login\` and confirm the resources named in wrangler.toml exist.`
    );
  }

  return {
    bindings: { ...env, MISTRAL_API_KEY: apiKey },
    dispose: () => proxy.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Small terminal helpers — no dependency needed for this much.
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
};

export function statusColor(status: string): string {
  switch (status) {
    case 'SUPPORTED':
      return c.green(status);
    case 'PARTIALLY_SUPPORTED':
      return c.yellow(status);
    case 'CONFLICTING_EVIDENCE':
      return c.magenta(status);
    case 'INSUFFICIENT_EVIDENCE':
      return c.red(status);
    default:
      return status;
  }
}

export function hr(char = '─', width = 74): string {
  return c.dim(char.repeat(width));
}
