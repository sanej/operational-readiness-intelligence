// Query-intent classification.
//
// Rules, not a model call. Intent selects presentation — which sections the
// answer carries and which instructions are layered onto the domain prompt —
// so a wrong classification costs a slightly ill-fitting answer shape, never a
// wrong fact. Grounding, citation validation, and the evidence status are
// identical across intents. That asymmetry is what makes a keyword classifier
// the right tool: an extra model call would add latency and a new failure mode
// to a decision whose blast radius is formatting.
//
// The bias is deliberate: when a question could be read either way, prefer the
// *narrower* structure. Answering a readiness question in general-QA shape
// still surfaces the evidence and the conflicts; answering a factual lookup in
// readiness shape buries a one-line answer inside a report.

import type { QueryIntent } from '../types';

/** Asking whether work can proceed, or what stands in the way. */
const READINESS = [
  /\bready\b/,
  /\breadiness\b/,
  /\bcan (?:we|i|they|work|the \w+)\b.*\b(?:proceed|start|begin|commence|go ahead)\b/,
  /\b(?:safe|cleared|clear|ok|okay) to (?:proceed|start|begin|operate|run)\b/,
  /\bfit (?:for|to) (?:service|use|purpose|proceed)\b/,
  /\bbefore (?:work|maintenance|the batch|production|release|proceeding)\b.*\b(?:begin|start|proceed|can)\b/,
  /\bwhat (?:must|needs? to|should) (?:be )?(?:verified|confirmed|checked)\b/,
  /\b(?:blockers?|blocking)\b/,
  /\bauthoris|authoriz|approved?\b/,
  /\brelease\b.*\bbatch\b/,
  // "can the batch be released", "is the batch released" — asking whether
  // release may happen is a readiness question however it is phrased.
  /\bbatch\b.*\breleas(?:e|ed|able)\b/,
  /\bcan\b.*\bbe releas/,
  /\bprerequisites?\b/,
  /\bsign(?:ed)?[- ]off\b/,
];

/** Asking directly about disagreement between sources. */
const CONFLICT = [
  /\bconflict/,
  /\bcontradict/,
  /\bdisagree/,
  /\binconsisten/,
  /\bwhich (?:revision|version)\b.*\b(?:applies|is current|is correct|should)\b/,
  /\b(?:superseded|out of date|outdated)\b/,
  /\bdiscrepanc/,
  /\bmismatch/,
];

/** Asking to pull together across records, or to enumerate a set. */
const SYNTHESIS = [
  /\b(?:which|what|list|show|any)\b.*\b(?:remain|outstanding|unresolved|open|overdue|pending)\b/,
  /\bacross\b.*\b(?:documents?|records?|procedures?)\b/,
  /\bsummar/,
  /\boverview\b/,
  /\ball (?:of the )?(?:findings|deviations|actions|capas?|records?|documents?)\b/,
  /\bhow many\b/,
];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

export interface IntentClassification {
  intent: QueryIntent;
  /** Which rule fired, for debugging and for the eval harness. */
  reason: string;
}

/**
 * Classify a question.
 *
 * Order matters. Readiness is checked first because a readiness question
 * frequently also mentions unresolved items ("is C-101 ready, and what
 * remains open?") — and there the fuller structure is correct. Conflict is
 * checked before synthesis for the same reason.
 */
export function classifyIntent(question: string): IntentClassification {
  const text = question.toLowerCase();

  if (matches(READINESS, text)) {
    return { intent: 'READINESS_ASSESSMENT', reason: 'asks whether work can proceed' };
  }

  if (matches(CONFLICT, text)) {
    return { intent: 'CONFLICT_CHECK', reason: 'asks about disagreement between sources' };
  }

  if (matches(SYNTHESIS, text)) {
    return { intent: 'SYNTHESIS', reason: 'asks to consolidate across records' };
  }

  return { intent: 'GENERAL_QA', reason: 'no readiness, conflict, or synthesis signal' };
}

/**
 * Instructions layered onto the shared scaffold and the domain prompt.
 *
 * The common thread is the last line of each: do not import material the
 * question did not ask for. Retrieval routinely surfaces an open finding or a
 * competing revision for almost any question about an asset; reporting them
 * every time is what turns a signal into noise.
 */
export const INTENT_INSTRUCTIONS: Record<QueryIntent, string> = {
  GENERAL_QA: `INTENT: direct question.
Give the minimum sufficient answer. Lead with the answer itself, not with context. If the question has a one-sentence answer, give one sentence and cite it, then stop.
Do not add a readiness assessment or an outstanding-items review.

ON CONTESTED DETAIL — this is the common failure. When the evidence contains a requirement that two revisions state differently, do NOT volunteer that dispute unless the question cannot be answered without it. Asked "what is the critical step", name the step. Do not go on to explain which isolation method one revision permits, or what another requires instead — that answers a question nobody asked, and it presents a contested specific as though it were settled.
If a contested detail genuinely IS the answer, give it in one sentence and attach a single clause naming the disagreement, e.g. "…per SP-204 Rev 7 §2.2, though Rev 6 states otherwise and neither is marked superseded."
Never expand a disputed point into its own paragraph in this mode.`,

  SYNTHESIS: `INTENT: consolidate across records.
Bring together what the evidence says across every relevant document. Group by subject rather than by source document, and attribute each point to the record it came from. Be complete over the set the question defines.
Do not extend into a readiness judgement unless the question asked for one.`,

  CONFLICT_CHECK: `INTENT: compare sources.
State plainly whether the sources agree. Where they conflict, quote both sides and name the specific difference — do not summarise it away. Say which revision, if any, is authoritative, and say so explicitly when that cannot be determined from the evidence.
If the sources do not in fact conflict on the point asked about, say so directly rather than reaching for an unrelated disagreement.`,

  READINESS_ASSESSMENT: `INTENT: readiness review.
This is the full assessment. Cover what the evidence establishes, what remains outstanding or overdue, what conflicts, what is missing, and what a qualified person must verify before acting.
An open finding or an overdue action against the asset in question is always material here and must be surfaced even if the question did not name it.`,
};
