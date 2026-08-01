// Citation validation and evidence-status enforcement.
//
// A model asked to cite its sources will sometimes cite a chunk that was never
// retrieved, or quote text that does not appear in the chunk it names. Both
// produce an answer that looks sourced and is not. In an operational-readiness
// setting that failure mode is the whole risk: an ungrounded "SUPPORTED" is
// worse than no answer, because it reads as a green light.
//
// So the evidence status the user sees is not the status the model asked for.
// The model proposes; this module enforces:
//   1. every cited chunk must be in the retrieved set;
//   2. the quoted text must genuinely appear in that chunk;
//   3. the final status is capped by what survived.
//
// Pure module: no network, no provider types, no bindings. Fully unit-testable.

import type { Citation, EvidenceConflict, EvidenceStatus, RetrievedChunk } from '../types';
import { newId } from '../ids';

/** A citation as the model returned it, before validation. */
export interface ClaimedCitation {
  chunk_id: string;
  quote: string;
  relevance?: number;
}

export type RejectionReason = 'unknown_chunk' | 'quote_not_in_chunk' | 'empty_quote';

export interface RejectedCitation {
  claimed: ClaimedCitation;
  reason: RejectionReason;
}

export interface ValidationOutcome {
  citations: Citation[];
  rejected: RejectedCitation[];
  evidenceStatus: EvidenceStatus;
  confidence: number;
  warnings: string[];
}

/**
 * Normalise for quote comparison.
 *
 * Models reflow whitespace, convert straight quotes to curly, and normalise
 * dashes when quoting. None of that changes whether the quote is really in the
 * source, so none of it should cause a false rejection.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether `quote` is genuinely grounded in `chunk`.
 *
 * Exact containment after normalisation is the primary test. Models often
 * quote with small elisions, so a long quote also passes when a strong
 * majority of its content words appear in the chunk. Short quotes get no such
 * latitude — with few words, high overlap is easy to hit by chance.
 */
export function isQuoteGrounded(quote: string, chunk: string): boolean {
  const q = normalize(quote);
  const c = normalize(chunk);

  if (!q) return false;
  if (c.includes(q)) return true;

  const words = q.split(' ').filter((w) => w.length > 3);
  if (words.length < 5) return false;

  const present = words.filter((w) => c.includes(w)).length;
  return present / words.length >= 0.8;
}

/**
 * Cap a claimed status by the evidence that actually survived.
 *
 * The invariant: nothing can be reported SUPPORTED without at least one
 * verified citation. CONFLICTING_EVIDENCE outranks a support claim, because a
 * user facing two contradicting documents needs to see the contradiction, not
 * an answer that quietly picked a side.
 */
export function enforceStatus(
  claimed: EvidenceStatus,
  survivingCitations: number,
  claimedCitations: number,
  hasConflicts: boolean,
  confidence: number
): { status: EvidenceStatus; confidence: number; warning?: string } {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0));

  // No verifiable evidence: nothing else can be claimed.
  if (survivingCitations === 0) {
    if (claimed === 'INSUFFICIENT_EVIDENCE') {
      return { status: 'INSUFFICIENT_EVIDENCE', confidence: clamped };
    }
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      warning:
        `Downgraded "${claimed}" to INSUFFICIENT_EVIDENCE: no citation survived validation` +
        (claimedCitations > 0 ? ` (${claimedCitations} claimed).` : '.'),
    };
  }

  // A real contradiction must surface even when both sides are well cited.
  if (hasConflicts && claimed !== 'CONFLICTING_EVIDENCE') {
    return {
      status: 'CONFLICTING_EVIDENCE',
      confidence: Math.min(clamped, 0.6),
      warning: `Raised "${claimed}" to CONFLICTING_EVIDENCE: conflicting evidence was detected in the retrieved set.`,
    };
  }

  // Some evidence was lost: the claim no longer rests on what it was built on.
  if (claimed === 'SUPPORTED' && survivingCitations < claimedCitations) {
    return {
      status: 'PARTIALLY_SUPPORTED',
      confidence: Math.min(clamped, 0.7),
      warning:
        `Downgraded SUPPORTED to PARTIALLY_SUPPORTED: ` +
        `${survivingCitations} of ${claimedCitations} citations verified.`,
    };
  }

  return { status: claimed, confidence: clamped };
}

/**
 * Validate the model's citations against the chunks actually retrieved, and
 * reconcile the evidence status with what survived.
 */
export function validateCitations(
  claimed: ClaimedCitation[],
  retrieved: RetrievedChunk[],
  claimedStatus: EvidenceStatus,
  claimedConfidence: number,
  conflicts: EvidenceConflict[]
): ValidationOutcome {
  const byId = new Map(retrieved.map((c) => [c.chunkId, c]));
  const citations: Citation[] = [];
  const rejected: RejectedCitation[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const claim of claimed) {
    const chunk = byId.get(claim.chunk_id);

    if (!chunk) {
      rejected.push({ claimed: claim, reason: 'unknown_chunk' });
      continue;
    }
    if (!claim.quote?.trim()) {
      rejected.push({ claimed: claim, reason: 'empty_quote' });
      continue;
    }
    if (!isQuoteGrounded(claim.quote, chunk.content)) {
      rejected.push({ claimed: claim, reason: 'quote_not_in_chunk' });
      continue;
    }

    // Collapse repeat citations of the same chunk.
    if (seen.has(chunk.chunkId)) continue;
    seen.add(chunk.chunkId);

    citations.push({
      id: newId('cit'),
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      citedContent: claim.quote.trim(),
      documentTitle: chunk.documentTitle,
      pageNumber: chunk.provenance.pageNumber,
      section: chunk.provenance.section ?? chunk.provenance.headingPath,
      revision: chunk.revision,
      relevanceScore: Math.max(0, Math.min(1, claim.relevance ?? chunk.adjustedScore)),
    });
  }

  if (rejected.length > 0) {
    const counts = {
      unknown_chunk: 0,
      quote_not_in_chunk: 0,
      empty_quote: 0,
    } as Record<RejectionReason, number>;
    for (const r of rejected) counts[r.reason]++;

    const parts = [
      counts.unknown_chunk ? `${counts.unknown_chunk} cited evidence that was not retrieved` : null,
      counts.quote_not_in_chunk
        ? `${counts.quote_not_in_chunk} quoted text not present in the cited source`
        : null,
      counts.empty_quote ? `${counts.empty_quote} had an empty quote` : null,
    ].filter(Boolean);

    warnings.push(`Dropped ${rejected.length} unverifiable citation(s): ${parts.join('; ')}.`);
  }

  const enforced = enforceStatus(
    claimedStatus,
    citations.length,
    claimed.length,
    conflicts.length > 0,
    claimedConfidence
  );

  if (enforced.warning) warnings.push(enforced.warning);

  return {
    citations,
    rejected,
    evidenceStatus: enforced.status,
    confidence: enforced.confidence,
    warnings,
  };
}
