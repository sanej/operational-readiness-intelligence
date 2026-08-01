// The ask pipeline: retrieve -> detect conflicts -> generate -> validate -> persist.
//
// This is the single entry point for answering a question, shared by the web
// API and the CLI. The ordering matters:
//
//   1. Retrieve with authority-aware ranking, so current revisions win.
//   2. Detect structural conflicts from metadata BEFORE generation, so the
//      model is told about a competing revision it might not otherwise notice.
//   3. Generate a structured answer with a proposed status.
//   4. Validate every citation against what was actually retrieved, and cap
//      the status by what survived. The model proposes; the system decides.
//
// Step 4 is why a "SUPPORTED" from ORI means something: it cannot be reached
// without at least one quote verified to exist in a retrieved chunk.

import { createConfig, type OriBindings } from './config';
import { validateCitations, type ClaimedCitation } from './citations/validate';
import { EmbeddingService } from './embeddings/mistral';
import { GenerationService } from './generation/generate';
import { newId } from './ids';
import { classifyIntent } from './generation/intent';
import { detectRevisionConflicts, documentSubject, RetrievalService } from './retrieval/retrieve';
import { Storage } from './storage';
import type {
  DomainPack,
  EvidenceConflict,
  GroundedAnswer,
  RetrievalFilters,
} from './types';

export interface AskInput {
  corpusId: string;
  question: string;
  topK?: number;
  filters?: RetrievalFilters;
  /** Skip the D1 write — used by the eval harness to avoid polluting history. */
  persist?: boolean;
}

/**
 * Reduce a section label to the subject it names, so the same section of two
 * revisions compares equal.
 *
 * Headings carry their document title and numbering — "SP-204 Energy Isolation
 * (Revised) > 2. Isolation Requirements" versus "SP-204 Energy Isolation >
 * 2. Isolation Requirements". Taking the last path segment and stripping the
 * leading number leaves "isolation requirements" on both sides.
 */
function normaliseSection(section: string | undefined): string | undefined {
  if (!section) return undefined;

  const leaf = section.split('>').pop()?.trim();
  if (!leaf) return undefined;

  const subject = leaf
    .replace(/^\d+(\.\d+)*\.?\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();

  return subject.length > 2 ? subject : undefined;
}

export class AskPipeline {
  private readonly storage: Storage;
  private readonly retrieval: RetrievalService;
  private readonly generation: GenerationService;
  private readonly config: ReturnType<typeof createConfig>;

  constructor(
    bindings: OriBindings,
    private readonly pack: DomainPack
  ) {
    this.config = createConfig(bindings);
    this.storage = new Storage(bindings);

    const embeddings = new EmbeddingService(this.config.mistral);
    this.retrieval = new RetrievalService(
      this.storage.d1,
      this.storage.vectors,
      embeddings,
      this.config.mistral
    );
    this.generation = new GenerationService(this.config.mistral);
  }

  async ask(input: AskInput): Promise<GroundedAnswer> {
    const startedAt = Date.now();
    const createdAt = new Date().toISOString();
    const id = newId('qst');

    const topK = input.topK ?? this.pack.defaultTopK ?? this.config.retrieval.defaultTopK;

    // Intent selects the answer's shape and the instructions layered onto the
    // domain prompt. It does not touch retrieval or the citation guarantee.
    const { intent } = classifyIntent(input.question);

    // -- 1. retrieve ---------------------------------------------------------
    const retrieved = await this.retrieval.retrieve({
      corpusId: input.corpusId,
      domain: this.pack.id,
      query: input.question,
      topK,
      filters: input.filters,
      authorityWeights: this.pack.authorityWeights,
    });

    // Nothing retrieved: there is nothing to ground an answer in, and calling
    // the model would only invite it to invent one.
    if (retrieved.chunks.length === 0) {
      const answer: GroundedAnswer = {
        id,
        corpusId: input.corpusId,
        domain: this.pack.id,
        question: input.question,
        answer:
          'No evidence in this corpus matched the question. Nothing can be concluded. ' +
          'Confirm that the relevant documents have been ingested, or rephrase the question ' +
          'using terminology that appears in the source documents.',
        evidenceStatus: 'INSUFFICIENT_EVIDENCE',
        confidence: 0,
        evidenceSupport: { verified: 0, claimed: 0, documents: 0, verifiedRatio: 0, label: 'none' },
        citations: [],
        retrievedChunks: [],
        missingEvidence: ['No documents in this corpus matched the question.'],
        conflicts: [],
        verificationRequired: [
          'Confirm the relevant documents have been uploaded and indexed for this corpus.',
        ],
        intent,
        warnings: [],
        timings: {
          retrievalMs: retrieved.latencyMs,
          generationMs: 0,
          totalMs: Date.now() - startedAt,
        },
        model: this.config.mistral.chatModel,
        createdAt,
      };

      if (input.persist !== false) await this.storage.d1.saveAnswer(answer);
      return answer;
    }

    // -- 2. structural conflict detection -----------------------------------
    const documentsById = new Map(
      await Promise.all(
        retrieved.documents.map(async (d) => {
          const row = await this.storage.d1.getDocument(d.id);
          const extra = row ? (JSON.parse(row.metadata || '{}') as Record<string, unknown>) : {};
          // Same grouping rule retrieval uses, so the two agree on what counts
          // as "the same document, different revision".
          const subject = documentSubject(extra);
          return [
            d.id,
            {
              documentType: d.documentType,
              revision: d.revision,
              status: d.status,
              title: d.title,
              subject,
            },
          ] as const;
        })
      )
    );

    const structuralConflicts = detectRevisionConflicts(retrieved.chunks, documentsById);

    // -- 3. generate ---------------------------------------------------------
    const generated = await this.generation.generate(
      input.question,
      retrieved.chunks,
      this.pack,
      // Only tell the model about structural conflicts when the question is
      // about readiness or about conflict itself. On a factual lookup, an
      // unrelated competing revision is a distraction that pulls the answer
      // away from what was asked.
      intent === 'READINESS_ASSESSMENT' || intent === 'CONFLICT_CHECK'
        ? structuralConflicts
        : [],
      intent
    );

    // Merge the model's semantic conflicts with the structural ones. Structural
    // conflicts are facts about the corpus; the model's are claims about
    // content, kept only when they name chunks that were actually retrieved.
    const retrievedIds = new Set(retrieved.chunks.map((c) => c.chunkId));
    const semanticConflicts: EvidenceConflict[] = generated.parsed.conflicts
      .filter((c) => c.description?.trim())
      .map((c) => {
        const chunkIds = (c.chunk_ids ?? []).filter((cid) => retrievedIds.has(cid));
        return {
          kind: 'substantive' as const,
          description: c.description,
          chunkIds,
          documentIds: [
            ...new Set(
              chunkIds
                .map((cid) => retrieved.chunks.find((rc) => rc.chunkId === cid)?.documentId)
                .filter((d): d is string => Boolean(d))
            ),
          ],
        };
      })
      // A conflict claim citing no real chunk is unverifiable, like any other
      // unsourced claim.
      .filter((c) => c.chunkIds.length > 0);

    // -- 4. validate citations and enforce status ----------------------------
    const claimed: ClaimedCitation[] = generated.parsed.citations.map((c) => ({
      chunk_id: c.chunk_id,
      quote: c.quote,
      relevance: c.relevance,
    }));

    // Validate first without conflicts, so the set of cited documents is known
    // before deciding which structural conflicts are material to this answer.
    const preliminary = validateCitations(
      claimed,
      retrieved.chunks,
      generated.parsed.evidence_status,
      generated.parsed.confidence,
      []
    );

    // A competing revision is only a conflict *for this question* if it bears
    // on it. Two revisions of an isolation procedure are retrieved for almost
    // any question about the asset they cover; reporting a conflict every time
    // makes the signal worthless, because a warning that fires on routine
    // questions is one a reviewer learns to dismiss.
    const citedDocumentIds = new Set(preliminary.citations.map((c) => c.documentId));

    // Which sections of each document the answer actually drew on. Two
    // revisions cited for *different* sections are not contradicting each
    // other — "Rev 7 §2.3 requires seal gas isolation" and "Rev 6 §4 lists the
    // permits" are both true and unrelated. They conflict only where they
    // cover the same ground.
    const citedSectionsByDocument = new Map<string, Set<string>>();
    for (const citation of preliminary.citations) {
      const section = normaliseSection(citation.section);
      if (!section) continue;
      const set = citedSectionsByDocument.get(citation.documentId) ?? new Set<string>();
      set.add(section);
      citedSectionsByDocument.set(citation.documentId, set);
    }

    const materialStructuralConflicts = structuralConflicts.filter((conflict) => {
      // Nothing was cited at all: no signal either way, and the corpus
      // inconsistency still stands, so surface it.
      if (citedDocumentIds.size === 0) return true;

      const citedSides = conflict.documentIds.filter((id) => citedDocumentIds.has(id));

      // One side or neither: the answer did not turn on where they differ.
      if (citedSides.length < 2) return false;

      // A readiness review legitimately draws on several sections of both
      // revisions, and an unresolved document-control inconsistency is
      // material to it whatever the sections. Conflict checks exist to report
      // exactly this. Both pass through.
      if (intent === 'READINESS_ASSESSMENT' || intent === 'CONFLICT_CHECK') return true;

      // For a narrow question, both sides must be cited from the same section
      // — otherwise they were used for different facts and are not
      // contradicting each other.
      const sectionSets = citedSides
        .map((id) => citedSectionsByDocument.get(id))
        .filter((s): s is Set<string> => Boolean(s));

      if (sectionSets.length < 2) return false;

      const sharedSections = [...sectionSets[0]].filter((s) =>
        sectionSets.slice(1).every((other) => other.has(s))
      );

      if (sharedSections.length === 0) return false;

      // And the disputed section must be what the question is about. Two
      // revisions of an isolation procedure genuinely disagree, but that
      // disagreement does not bear on "which are the critical failure paths?"
      // — the answer cited them for context, not for the contested point.
      // Without this the conflict fires on any question that happens to touch
      // the asset, which is the noise the whole filter exists to prevent.
      const questionWords = new Set(
        input.question
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3)
      );

      return sharedSections.some((section) =>
        section.split(' ').some((word) => word.length > 3 && questionWords.has(word))
      );
    });

    // The same standard applies to the model's own conflict claims. It will
    // faithfully report that two retrieved revisions disagree even when the
    // question was about something neither of them governs — true, but not an
    // answer to what was asked, and it would set the status to
    // CONFLICTING_EVIDENCE for a question that is cleanly supported.
    const materialSemanticConflicts = semanticConflicts.filter((conflict) => {
      if (citedDocumentIds.size === 0) return true;

      // Outside readiness and conflict checks, a semantic conflict only counts
      // if a structural one survived the same test. The model reports every
      // disagreement it notices in the retrieved set, faithfully but without
      // regard to what was asked.
      if (
        intent !== 'READINESS_ASSESSMENT' &&
        intent !== 'CONFLICT_CHECK' &&
        materialStructuralConflicts.length === 0
      ) {
        return false;
      }

      // A contradiction is between two sources. If the answer only drew on one
      // of them, the disagreement did not bear on what was asked. A conflict
      // confined to a single document is kept — that is an internal
      // inconsistency in a document the answer did rely on.
      const cited = conflict.documentIds.filter((id) => citedDocumentIds.has(id)).length;
      return conflict.documentIds.length < 2 ? cited >= 1 : cited >= 2;
    });

    const conflicts = [...materialStructuralConflicts, ...materialSemanticConflicts];

    // Re-run enforcement with the conflicts that survived, so the status
    // reflects them.
    const validated = validateCitations(
      claimed,
      retrieved.chunks,
      generated.parsed.evidence_status,
      generated.parsed.confidence,
      conflicts
    );

    // An operational question always leaves something for a human to confirm.
    const verificationRequired =
      generated.parsed.verification_required.length > 0
        ? generated.parsed.verification_required
        : [
            'Confirm these findings against the controlled source documents before acting.',
          ];

    // A non-SUPPORTED status asserts that something is absent or contested. An
    // empty missing-evidence list alongside it is self-contradictory, and it
    // strips the reader of the one thing that makes such an answer actionable:
    // knowing what to go and find. The prompt asks for this; enforce it too,
    // because the prompt cannot guarantee it.
    const missingEvidence =
      generated.parsed.missing_evidence.length > 0 || validated.evidenceStatus === 'SUPPORTED'
        ? generated.parsed.missing_evidence
        : [
            'The evidence in this corpus does not fully answer the question, but the specific ' +
              'gap was not identified. Review the retrieved evidence below and confirm which ' +
              'controlled documents are missing.',
          ];

    const answer: GroundedAnswer = {
      id,
      corpusId: input.corpusId,
      domain: this.pack.id,
      question: input.question,
      answer: generated.parsed.answer,
      evidenceStatus: validated.evidenceStatus,
      claimedStatus: generated.parsed.evidence_status,
      confidence: validated.confidence,
      evidenceSupport: validated.evidenceSupport,
      citations: validated.citations,
      retrievedChunks: retrieved.chunks,
      missingEvidence,
      conflicts,
      verificationRequired,
      intent,
      warnings: validated.warnings,
      timings: {
        retrievalMs: retrieved.latencyMs,
        generationMs: generated.generationMs,
        totalMs: Date.now() - startedAt,
      },
      usage: generated.usage,
      model: generated.model,
      createdAt,
    };

    if (input.persist !== false) await this.storage.d1.saveAnswer(answer);

    return answer;
  }
}
