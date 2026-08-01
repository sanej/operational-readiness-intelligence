// Grounded answer generation.
//
// The model is asked for structured JSON: an answer, a proposed evidence
// status, citations with verbatim quotes, missing evidence, conflicts, and
// what a human must verify. It is *not* trusted on the status — that is
// enforced downstream by citation validation.
//
// The system prompt is assembled from two parts: a shared scaffold that every
// domain gets (grounding rules, the no-approval constraint, the four statuses)
// and the domain pack's own prompt (terminology, document types, what a
// competent reviewer in that field would look for). No industry vocabulary
// appears in this file.

import { z } from 'zod';
import { MISTRAL_API_BASE, type MistralConfig } from '../config';
import { fetchWithRetry } from '../embeddings/mistral';
import { EVIDENCE_STATUSES, type DomainPack, type EvidenceConflict, type EvidenceStatus, type RetrievedChunk } from '../types';

// ===========================================================================
// Structured output contract
// ===========================================================================

const ModelCitationSchema = z.object({
  chunk_id: z.string(),
  quote: z.string(),
  relevance: z.number().min(0).max(1).optional(),
});

const ModelConflictSchema = z.object({
  description: z.string(),
  chunk_ids: z.array(z.string()).default([]),
});

/**
 * The model is asked for `answer` as a single Markdown string, but when the
 * prompt supplies an answer structure it will sometimes honour that structure
 * literally and return an object keyed by section heading. That is a
 * reasonable reading of the instruction, so accept it and flatten to Markdown
 * rather than discarding a good answer over its container type.
 */
const AnswerFieldSchema = z.union([z.string(), z.record(z.string(), z.unknown())]).transform(
  (value) => (typeof value === 'string' ? value : renderSections(value))
);

function renderSections(value: Record<string, unknown>): string {
  const humanise = (key: string) =>
    key
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^\w/, (ch) => ch.toUpperCase());

  const renderValue = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) {
      return v.map((item) => `- ${renderValue(item).replace(/\n/g, ' ')}`).join('\n');
    }
    if (typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>)
        .map(([k, inner]) => `**${humanise(k)}**\n${renderValue(inner)}`)
        .join('\n\n');
    }
    return String(v);
  };

  return Object.entries(value)
    .map(([key, inner]) => {
      const body = renderValue(inner).trim();
      return body ? `## ${humanise(key)}\n\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

const ModelAnswerSchema = z.object({
  answer: AnswerFieldSchema,
  evidence_status: z.enum(EVIDENCE_STATUSES),
  confidence: z.number().min(0).max(1),
  citations: z.array(ModelCitationSchema).default([]),
  missing_evidence: z.array(z.string()).default([]),
  conflicts: z.array(ModelConflictSchema).default([]),
  verification_required: z.array(z.string()).default([]),
});

export type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

export interface GenerationOutput {
  parsed: ModelAnswer;
  usage: { promptTokens?: number; completionTokens?: number };
  model: string;
  generationMs: number;
}

// ===========================================================================
// Prompt assembly
// ===========================================================================

/**
 * Rules that apply in every domain.
 *
 * The no-approval constraint is the load-bearing one. ORI supports a human
 * decision; it must never read as having made it. That is both a safety
 * property and, in regulated settings, the difference between a decision-
 * support tool and something that would need to be validated as a system of
 * record.
 */
const SHARED_SCAFFOLD = `You are an operational-readiness evidence analyst. You answer questions strictly from the supplied EVIDENCE, to help a qualified human reviewer reach their own decision.

ABSOLUTE CONSTRAINTS
1. Use ONLY the supplied EVIDENCE. Never use outside knowledge, and never infer a fact that the evidence does not state.
2. Every factual claim in your answer must be supported by a citation whose "quote" is copied VERBATIM from the evidence chunk you cite. Do not paraphrase inside a quote. Do not cite a chunk id that does not appear in the EVIDENCE below.
3. You do NOT approve, authorise, certify, clear, or sign off anything. You never state or imply that equipment, work, production, a batch, or any regulated process is approved, released, compliant, or safe to proceed. You report what the evidence shows and what remains to be verified. A qualified human makes the decision.
4. Prefer the most current and authoritative revision when evidence differs. If two sources conflict and neither is clearly superseded, report the conflict rather than choosing between them.
5. When the evidence does not answer the question, say so plainly and list what is missing. An honest "the evidence does not cover this" is a correct and valuable answer. Never fill a gap with a plausible guess.
6. Always populate "verification_required" with the specific things a human must confirm before acting. This is never empty for an operational question.
7. Whenever the status is not SUPPORTED, "missing_evidence" must list the specific documents or records that would be needed to answer fully. Choosing PARTIALLY_SUPPORTED or INSUFFICIENT_EVIDENCE while leaving it empty is self-contradictory: you have said something is absent without saying what.

EVIDENCE STATUS — choose exactly one:
- SUPPORTED: the evidence directly and completely answers the question, with no material gaps or contradictions.
- PARTIALLY_SUPPORTED: the evidence answers part of the question, but material elements are missing or only indirectly addressed.
- CONFLICTING_EVIDENCE: two or more sources give materially different answers and neither is clearly authoritative.
- INSUFFICIENT_EVIDENCE: the evidence does not meaningfully address the question.

Be conservative. If you are choosing between two statuses, pick the weaker one.

WRITING THE ANSWER
The "answer" field is prose for a human reader. Write it as a single Markdown string using "## " headings for the sections given below. Do not return it as a JSON object.
Never put chunk ids, quote blocks, or citation objects inside the answer text — citations belong only in the "citations" array, and the interface renders them separately. Refer to sources the way a colleague would: "IR-2026-014 Rev 1 §2 records the finding as open". Keep it tight; a reviewer should be able to scan it.`;

function buildSystemPrompt(pack: DomainPack): string {
  const terminology = Object.entries(pack.terminology)
    .map(([term, meaning]) => `- ${term}: ${meaning}`)
    .join('\n');

  const structure = pack.answerStructure.map((s, i) => `${i + 1}. ${s}`).join('\n');

  return `${SHARED_SCAFFOLD}

===========================================================================
DOMAIN: ${pack.displayName}
===========================================================================
${pack.systemPrompt}

DOMAIN TERMINOLOGY
${terminology}

ANSWER STRUCTURE — organise the "answer" field under these headings, omitting any for which you have nothing evidenced to say:
${structure}`;
}

/**
 * Render retrieved chunks for the prompt.
 *
 * Each chunk is labelled with the exact id the model must cite, plus the
 * provenance a reviewer needs to judge weight: document, revision, effective
 * date, lifecycle status, page and section. Making revision and status visible
 * is what lets the model notice a conflict at all.
 */
function buildEvidenceBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(No evidence was retrieved for this question.)';

  return chunks
    .map((chunk) => {
      const meta = [
        chunk.documentTitle ? `document: ${chunk.documentTitle}` : null,
        chunk.documentType ? `type: ${chunk.documentType}` : null,
        chunk.revision ? `revision: ${chunk.revision}` : null,
        chunk.effectiveDate ? `effective: ${chunk.effectiveDate}` : null,
        chunk.documentStatus ? `lifecycle: ${chunk.documentStatus}` : null,
        chunk.authority ? `authority: ${chunk.authority}` : null,
        chunk.provenance.pageNumber ? `page: ${chunk.provenance.pageNumber}` : null,
        chunk.provenance.headingPath
          ? `section: ${chunk.provenance.headingPath}`
          : chunk.provenance.section
            ? `section: ${chunk.provenance.section}`
            : null,
      ]
        .filter(Boolean)
        .join(' | ');

      return `<evidence chunk_id="${chunk.chunkId}">
[${meta}]
${chunk.content}
</evidence>`;
    })
    .join('\n\n');
}

function buildUserPrompt(
  question: string,
  chunks: RetrievedChunk[],
  structuralConflicts: EvidenceConflict[]
): string {
  const conflictNote =
    structuralConflicts.length > 0
      ? `\n\nSYSTEM-DETECTED CONFLICTS (found by comparing document metadata — treat as established fact and reflect them in your answer):\n${structuralConflicts
          .map((c) => `- ${c.description}`)
          .join('\n')}`
      : '';

  return `QUESTION: ${question}

EVIDENCE:
${buildEvidenceBlock(chunks)}${conflictNote}

Respond with a single JSON object and nothing else:
{
  "answer": "your answer, organised under the domain's answer structure",
  "evidence_status": "SUPPORTED | PARTIALLY_SUPPORTED | CONFLICTING_EVIDENCE | INSUFFICIENT_EVIDENCE",
  "confidence": 0.0-1.0,
  "citations": [
    { "chunk_id": "the exact chunk_id from the evidence above", "quote": "verbatim text copied from that chunk", "relevance": 0.0-1.0 }
  ],
  "missing_evidence": ["specific documents or records that would be needed to answer fully"],
  "conflicts": [ { "description": "what contradicts what", "chunk_ids": ["..."] } ],
  "verification_required": ["what a qualified human must confirm before acting"]
}`;
}

// ===========================================================================
// Generation
// ===========================================================================

export class GenerationService {
  constructor(private readonly config: MistralConfig) {}

  async generate(
    question: string,
    chunks: RetrievedChunk[],
    pack: DomainPack,
    structuralConflicts: EvidenceConflict[]
  ): Promise<GenerationOutput> {
    const started = Date.now();

    const response = await fetchWithRetry(`${MISTRAL_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.chatModel,
        messages: [
          { role: 'system', content: buildSystemPrompt(pack) },
          { role: 'user', content: buildUserPrompt(question, chunks, structuralConflicts) },
        ],
        // Near-deterministic: this is an extraction task, not a creative one.
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      }),
    });

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Mistral returned no content');

    const parsed = parseModelAnswer(content, chunks.length);

    return {
      parsed,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
      model: data.model ?? this.config.chatModel,
      generationMs: Date.now() - started,
    };
  }
}

/**
 * Parse and validate the model's JSON.
 *
 * A malformed response must not become a confident answer. Any parse or schema
 * failure degrades to INSUFFICIENT_EVIDENCE with no citations, which the
 * downstream validator will keep at that level — the safe direction to fail.
 */
export function parseModelAnswer(content: string, evidenceCount: number): ModelAnswer {
  let json: unknown;

  try {
    json = JSON.parse(content);
  } catch {
    // Some models wrap JSON in prose or a code fence despite json_object mode.
    const match = /\{[\s\S]*\}/.exec(content);
    if (!match) return fallbackAnswer(evidenceCount, 'the model response was not valid JSON');
    try {
      json = JSON.parse(match[0]);
    } catch {
      return fallbackAnswer(evidenceCount, 'the model response was not valid JSON');
    }
  }

  const result = ModelAnswerSchema.safeParse(json);

  if (result.success) {
    return { ...result.data, answer: stripInlineChunkRefs(result.data.answer) };
  }

  // Salvage a usable answer if the failure was only in the metadata fields.
  const rawAnswer = (json as { answer?: unknown })?.answer;
  const answer =
    typeof rawAnswer === 'string'
      ? rawAnswer
      : rawAnswer && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)
        ? renderSections(rawAnswer as Record<string, unknown>)
        : undefined;

  return fallbackAnswer(
    evidenceCount,
    `the model response did not match the required schema (${result.error.issues[0]?.message ?? 'unknown issue'})`,
    answer ? stripInlineChunkRefs(answer) : undefined
  );
}

/**
 * Remove internal chunk ids the model sometimes threads into the prose.
 *
 * Chunk ids are an implementation detail of retrieval. Rendered inline they
 * are noise to a reviewer, and they duplicate the citation list where the same
 * evidence is already presented with real provenance.
 */
export function stripInlineChunkRefs(text: string): string {
  return text
    // Markdown links whose label is a chunk id: [chk_abc](#) or ([chk_abc](#))
    .replace(/\(?\[`?chk_[0-9a-f]+`?\]\([^)]*\)\)?/g, '')
    // Bare or backticked ids, with or without surrounding parentheses.
    .replace(/\(\s*`?chk_[0-9a-f]+`?\s*\)/g, '')
    .replace(/`?\bchk_[0-9a-f]+`?/g, '')
    // Tidy the punctuation left behind.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fallbackAnswer(
  evidenceCount: number,
  reason: string,
  salvagedAnswer?: string
): ModelAnswer {
  return {
    answer:
      salvagedAnswer ??
      `An answer could not be produced because ${reason}. ` +
        `${evidenceCount} evidence chunk(s) were retrieved; review them directly below.`,
    evidence_status: 'INSUFFICIENT_EVIDENCE',
    confidence: 0,
    citations: [],
    missing_evidence: [],
    conflicts: [],
    verification_required: [
      'Answer generation failed validation — review the retrieved evidence manually.',
    ],
  };
}

/** Exported for tests and for the eval harness. */
export const __internal = { buildSystemPrompt, buildEvidenceBlock, buildUserPrompt };

export type { EvidenceStatus };
