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
  /** Deterministic support score; see computeEvidenceSupport. */
  evidenceSupport: EvidenceSupport;
  warnings: string[];
}

/**
 * How well the answer is backed by verifiable evidence.
 *
 * This deliberately replaces the model's self-reported confidence in the UI.
 * A number an LLM produces about its own certainty is not calibrated against
 * anything — a 0.98 and a 0.62 from the same model do not reliably differ in
 * accuracy — and displaying one invites a reader to treat it as a measurement.
 *
 * Every input here is counted, not asserted: how many citations the model
 * offered, how many survived verification against the retrieved text, and how
 * many distinct documents those surviving citations reach. The model's
 * confidence is still recorded in D1 for audit, but it is not what the
 * interface shows.
 */
export interface EvidenceSupport {
  /** Citations that survived validation. */
  verified: number;
  /** Citations the model claimed. */
  claimed: number;
  /** Distinct documents the surviving citations reach. */
  documents: number;
  /** verified / claimed, or 0 when nothing was claimed. */
  verifiedRatio: number;
  /** Plain-language summary for the interface. */
  label: 'strong' | 'moderate' | 'weak' | 'none';
}

/**
 * Score the evidence behind an answer from what actually survived.
 *
 * The thresholds are a presentation choice, not a probability. "Strong" means
 * every claimed citation verified and more than one document supports the
 * answer; "weak" means something survived but not much. Nothing here is a
 * likelihood that the answer is correct, and the label is worded so it cannot
 * be read as one.
 */
export function computeEvidenceSupport(
  citations: Citation[],
  claimedCount: number
): EvidenceSupport {
  const verified = citations.length;
  const documents = new Set(citations.map((c) => c.documentId)).size;
  const verifiedRatio = claimedCount > 0 ? verified / claimedCount : 0;

  let label: EvidenceSupport['label'];
  if (verified === 0) label = 'none';
  else if (verifiedRatio === 1 && documents > 1) label = 'strong';
  else if (verifiedRatio >= 0.6) label = 'moderate';
  else label = 'weak';

  return { verified, claimed: claimedCount, documents, verifiedRatio, label };
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
 * Exact containment after typographic normalisation is the only test. A
 * content-word-overlap fallback looks convenient, but it can accept reordered
 * words or a partly invented sentence as a quotation. In this system a false
 * rejection is recoverable (the status is downgraded); a false acceptance can
 * make unsupported prose look verified.
 */
export function isQuoteGrounded(quote: string, chunk: string): boolean {
  const q = normalize(quote);
  const c = normalize(chunk);

  return q.length > 0 && c.includes(q);
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
    evidenceSupport: computeEvidenceSupport(citations, claimed.length),
    warnings,
  };
}
