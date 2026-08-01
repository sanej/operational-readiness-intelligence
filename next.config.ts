import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const nextConfig: NextConfig = {};

export default nextConfig;

// Make the Cloudflare bindings available under `next dev`.
//
// Without this, `getCloudflareContext()` throws in development and every API
// route returns 500 — the app looks broken when it is only unbound. Because
// wrangler.toml declares D1, R2, and Vectorize as `remote = true`, this gives
// `npm run dev` the same live resources the deployed Worker uses, with hot
// reload on top.
//
// `npm run preview` remains the higher-fidelity check: it runs the real
// workerd runtime rather than Node with bindings attached.
initOpenNextCloudflareForDev();
