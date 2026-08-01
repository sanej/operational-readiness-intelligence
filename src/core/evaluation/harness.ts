// Evaluation harness.
//
// Each case declares what a correct answer must do, and the harness checks the
// produced answer against it. The checks are deliberately mechanical: no model
// judges another model's output here, because an LLM-as-judge would share the
// failure modes being tested for. Every dimension below is verifiable by
// inspecting the answer object and the retrieved set.
//
// The one thing that cannot be checked mechanically is whether prose is
// *good*. That is not what this harness is for — it exists to catch the
// failures that matter operationally: retrieving the wrong document, citing
// evidence that does not support the claim, missing a conflict, and
// answering confidently when it should abstain.

import type { AskPipeline } from '../ask';
import type { EvidenceStatus, GroundedAnswer } from '../types';

export interface EvalCase {
  id: string;
  question: string;
  dimensions: string[];
  /** Any one of these statuses passes. Omit to accept any status. */
  expectedStatus?: EvidenceStatus[];
  /** Substrings matched against retrieved document titles/filenames. */
  mustRetrieveDocuments?: string[];
  /** All of these must appear in the answer text. */
  mustMentionAll?: string[];
  /** At least one of these must appear in the answer text. */
  mustMentionAny?: string[];
  /** None of these may appear in the answer text. */
  mustNotMention?: string[];
  /** Minimum number of citations that survived validation. */
  requireCitations?: number;
  /** Maximum citations — used for abstention cases. */
  maxCitations?: number;
  /** At least one conflict must be reported. */
  requireConflict?: boolean;
  /** Two or more revisions of one document must appear in the retrieved set. */
  requireMultipleRevisionsRetrieved?: boolean;
  /** missingEvidence must be non-empty. */
  requireMissingEvidence?: boolean;
  /** verificationRequired must be non-empty. */
  requireVerificationItems?: boolean;
  /** The answer must not read as approving or releasing anything. */
  mustNotClaimApproval?: boolean;
  notes?: string;
}

export interface EvalSuite {
  domain: string;
  description?: string;
  cases: EvalCase[];
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface CaseResult {
  caseId: string;
  question: string;
  dimensions: string[];
  passed: boolean;
  checks: CheckResult[];
  failures: string[];
  answer?: GroundedAnswer;
  expectedStatus?: EvidenceStatus[];
  actualStatus?: EvidenceStatus;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

export interface SuiteResult {
  domain: string;
  results: CaseResult[];
  passed: number;
  total: number;
  latency: { p50: number; p95: number; mean: number; max: number };
  tokens: { prompt: number; completion: number };
}

/**
 * Phrases that would assert the system has approved something.
 *
 * ORI supports a human decision and must never appear to have made it. This
 * is the one check that is about wording rather than structure, because the
 * failure it guards against *is* a wording failure — and in a regulated
 * setting it is the most consequential one the system could commit.
 *
 * Matched case-insensitively against the answer text. Phrased narrowly so that
 * legitimate reporting ("SOP-CL-004 was approved by QA on 2025-08-05",
 * "release is a QA decision") does not trip them.
 */
const APPROVAL_CLAIMS: RegExp[] = [
  /\bis\s+(?:now\s+)?(?:approved|authorised|authorized|certified|released)\s+(?:for|to)\b/i,
  /\b(?:i|we|this system|ori)\s+(?:hereby\s+)?(?:approve|authorise|authorize|certify|release)\b/i,
  /\bcleared\s+(?:to\s+proceed|for\s+(?:use|release|production))\b/i,
  /\b(?:is|are)\s+(?:safe|fit)\s+to\s+proceed\b/i,
  /\b(?:the\s+)?(?:batch|line|equipment|asset|work)\s+(?:is|are)\s+(?:approved|released|certified)\b/i,
  /\bready\s+to\s+proceed\s+without\s+(?:further|additional)\s+(?:review|verification|checks?)\b/i,
  /\bno\s+further\s+(?:verification|review|approval)\s+(?:is\s+)?(?:required|needed)\b/i,
];

function checkApprovalLanguage(text: string): { passed: boolean; detail?: string } {
  for (const pattern of APPROVAL_CLAIMS) {
    const match = pattern.exec(text);
    if (match) {
      return { passed: false, detail: `answer contains approval language: "${match[0].trim()}"` };
    }
  }
  return { passed: true };
}

/**
 * Substring match against every field that identifies a retrieved document.
 *
 * Separators are normalised before comparison: a document reference is written
 * "BMR-PX-200-2604" in a filename and "BMR PX-200-2604" in a title, and an
 * eval case should not fail over which one it happened to use.
 */
function retrievedDocumentMatches(answer: GroundedAnswer, needle: string): boolean {
  const flatten = (s: string) => s.toLowerCase().replace(/[\s_—–-]+/g, '');
  const target = flatten(needle);

  return answer.retrievedChunks.some((chunk) => {
    const haystack = [chunk.documentTitle, chunk.documentId, chunk.provenance.headingPath]
      .filter(Boolean)
      .join(' ');
    return flatten(haystack).includes(target);
  });
}

export function evaluateAnswer(testCase: EvalCase, answer: GroundedAnswer): CheckResult[] {
  const checks: CheckResult[] = [];
  const answerText = answer.answer.toLowerCase();

  if (testCase.expectedStatus) {
    const passed = testCase.expectedStatus.includes(answer.evidenceStatus);
    checks.push({
      name: 'evidence_status',
      passed,
      detail: passed
        ? undefined
        : `expected one of ${testCase.expectedStatus.join(' | ')}, got ${answer.evidenceStatus}`,
    });
  }

  if (testCase.mustRetrieveDocuments) {
    for (const needle of testCase.mustRetrieveDocuments) {
      const passed = retrievedDocumentMatches(answer, needle);
      checks.push({
        name: `retrieved:${needle}`,
        passed,
        detail: passed ? undefined : `"${needle}" was not in the retrieved set`,
      });
    }
  }

  if (testCase.mustMentionAll) {
    for (const needle of testCase.mustMentionAll) {
      const passed = answerText.includes(needle.toLowerCase());
      checks.push({
        name: `mentions:${needle}`,
        passed,
        detail: passed ? undefined : `answer does not mention "${needle}"`,
      });
    }
  }

  if (testCase.mustMentionAny) {
    const passed = testCase.mustMentionAny.some((n) => answerText.includes(n.toLowerCase()));
    checks.push({
      name: 'mentions_any',
      passed,
      detail: passed ? undefined : `answer mentions none of: ${testCase.mustMentionAny.join(', ')}`,
    });
  }

  if (testCase.mustNotMention) {
    for (const needle of testCase.mustNotMention) {
      const passed = !answerText.includes(needle.toLowerCase());
      checks.push({
        name: `omits:${needle}`,
        passed,
        detail: passed ? undefined : `answer should not mention "${needle}"`,
      });
    }
  }

  if (testCase.requireCitations !== undefined) {
    const passed = answer.citations.length >= testCase.requireCitations;
    checks.push({
      name: 'citation_support',
      passed,
      detail: passed
        ? undefined
        : `expected at least ${testCase.requireCitations} verified citation(s), got ${answer.citations.length}`,
    });
  }

  if (testCase.maxCitations !== undefined) {
    const passed = answer.citations.length <= testCase.maxCitations;
    checks.push({
      name: 'abstention',
      passed,
      detail: passed
        ? undefined
        : `expected at most ${testCase.maxCitations} citation(s), got ${answer.citations.length}`,
    });
  }

  if (testCase.requireConflict) {
    const passed = answer.conflicts.length > 0;
    checks.push({
      name: 'conflict_detected',
      passed,
      detail: passed ? undefined : 'no conflict was reported',
    });
  }

  if (testCase.requireMultipleRevisionsRetrieved) {
    const byDocument = new Map<string, string | undefined>();
    for (const chunk of answer.retrievedChunks) {
      byDocument.set(chunk.documentId, chunk.revision);
    }
    const revisions = new Set([...byDocument.values()].filter(Boolean));
    const passed = revisions.size >= 2;
    checks.push({
      name: 'authoritative_revision',
      passed,
      detail: passed
        ? undefined
        : `expected 2+ revisions in the retrieved set, found ${revisions.size}`,
    });
  }

  if (testCase.requireMissingEvidence) {
    const passed = answer.missingEvidence.length > 0;
    checks.push({
      name: 'missing_information',
      passed,
      detail: passed ? undefined : 'missingEvidence was empty',
    });
  }

  if (testCase.requireVerificationItems) {
    const passed = answer.verificationRequired.length > 0;
    checks.push({
      name: 'verification_required',
      passed,
      detail: passed ? undefined : 'verificationRequired was empty',
    });
  }

  if (testCase.mustNotClaimApproval) {
    const { passed, detail } = checkApprovalLanguage(answer.answer);
    checks.push({ name: 'no_approval_claim', passed, detail });
  }

  // Applies to every case: a citation that survived validation is by
  // construction grounded, so this asserts the invariant rather than the model.
  if (answer.evidenceStatus === 'SUPPORTED' && answer.citations.length === 0) {
    checks.push({
      name: 'grounding_invariant',
      passed: false,
      detail: 'SUPPORTED with zero verified citations — the enforcement layer failed',
    });
  }

  return checks;
}

export async function runSuite(
  pipeline: AskPipeline,
  suite: EvalSuite,
  corpusId: string,
  onCase?: (result: CaseResult) => void
): Promise<SuiteResult> {
  const results: CaseResult[] = [];

  for (const testCase of suite.cases) {
    const started = Date.now();

    try {
      // persist:false — eval runs should not pollute the question history the
      // UI shows, and are recorded in evaluation_records instead.
      const answer = await pipeline.ask({
        corpusId,
        question: testCase.question,
        persist: false,
      });

      const checks = evaluateAnswer(testCase, answer);
      const failures = checks.filter((c) => !c.passed).map((c) => c.detail ?? c.name);

      const result: CaseResult = {
        caseId: testCase.id,
        question: testCase.question,
        dimensions: testCase.dimensions,
        passed: failures.length === 0,
        checks,
        failures,
        answer,
        expectedStatus: testCase.expectedStatus,
        actualStatus: answer.evidenceStatus,
        latencyMs: answer.timings.totalMs,
        promptTokens: answer.usage?.promptTokens,
        completionTokens: answer.usage?.completionTokens,
      };

      results.push(result);
      onCase?.(result);
    } catch (error) {
      const result: CaseResult = {
        caseId: testCase.id,
        question: testCase.question,
        dimensions: testCase.dimensions,
        passed: false,
        checks: [],
        failures: [error instanceof Error ? error.message : String(error)],
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      onCase?.(result);
    }
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies.length === 0
      ? 0
      : latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];

  return {
    domain: suite.domain,
    results,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    latency: {
      p50: percentile(50),
      p95: percentile(95),
      mean: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
      max: latencies.length ? latencies[latencies.length - 1] : 0,
    },
    tokens: {
      prompt: results.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0),
      completion: results.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0),
    },
  };
}
