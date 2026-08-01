// Domain registry.
//
// The only place the application enumerates domains. Adding a third pack means
// adding one import and one entry here — nothing in src/core changes.

import type { DomainPack } from '../core/types';
import { industrialPack } from './industrial/config';
import { pharmaPack } from './pharma/config';

export const DOMAIN_PACKS: Record<string, DomainPack> = {
  [industrialPack.id]: industrialPack,
  [pharmaPack.id]: pharmaPack,
};

export const DEFAULT_DOMAIN = industrialPack.id;

export function getDomainPack(id: string | null | undefined): DomainPack {
  const pack = DOMAIN_PACKS[id ?? ''];
  if (!pack) {
    throw new Error(
      `Unknown domain "${id}". Available: ${Object.keys(DOMAIN_PACKS).join(', ')}.`
    );
  }
  return pack;
}

export function listDomains(): Array<{
  id: string;
  displayName: string;
  description: string;
}> {
  return Object.values(DOMAIN_PACKS).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
  }));
}

/** Conventional corpus id per domain, used by the CLI and the demo UI. */
export function defaultCorpusId(domain: string): string {
  return `${domain}-demo`;
}

export { industrialPack, pharmaPack };
