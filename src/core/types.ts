// Shared types for the ORI core pipeline.
//
// Nothing in this file may reference a specific industry. Industrial and
// pharma vocabulary belongs in src/domains/*; the pipeline only knows that a
// domain pack exists and satisfies the DomainPack contract.

import type { z } from 'zod';

// ===========================================================================
// Evidence status
// ===========================================================================

/**
 * The four outcomes every answer must resolve to.
 *
 * These describe the state of the *evidence*, not the state of the equipment
 * or process. ORI never reports that work is approved — only what the
 * documents do and do not support, and what a human still has to verify.
 */
export const EVIDENCE_STATUSES = [
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'CONFLICTING_EVIDENCE',
  'INSUFFICIENT_EVIDENCE',
] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export function isEvidenceStatus(value: unknown): value is EvidenceStatus {
  return typeof value === 'string' && (EVIDENCE_STATUSES as readonly string[]).includes(value);
}

// ===========================================================================
// Documents and chunks
// ===========================================================================

export type ExtractionMethod = 'ocr' | 'direct' | 'structured';

/**
 * Metadata the shared pipeline understands for every document, in every
 * domain. Anything beyond this is domain-defined and lives in `extra`.
 */
export interface CommonDocumentMetadata {
  title?: string;
  /** Domain-defined vocabulary, validated by the pack's metadata schema. */
  documentType?: string;
  revision?: string;
  effectiveDate?: string;
  authority?: string;
  /** Lifecycle state; drives authority ranking and conflict detection. */
  status?: 'active' | 'superseded' | 'draft' | 'withdrawn';
  supersededBy?: string;
}

export interface DocumentMetadata extends CommonDocumentMetadata {
  /** Domain-specific fields, already validated by the domain pack. */
  extra: Record<string, string | number | boolean>;
}

export interface DocumentRecord {
  id: string;
  corpusId: string;
  domain: string;
  fileName: string;
  originalFileName: string;
  fileType: string;
  mimeType: string;
  fileSize: number;
  r2Key: string;
  parsedR2Key?: string;
  contentHash: string;
  extractionMethod: ExtractionMethod;
  pageCount?: number;
  language?: string;
  metadata: DocumentMetadata;
  status: 'pending' | 'processing' | 'indexed' | 'failed';
  errorMessage?: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Where a chunk came from. A citation is only useful if it can be pointed at. */
export interface ChunkProvenance {
  pageNumber?: number;
  section?: string;
  /** Breadcrumb of enclosing headings, e.g. 'Isolation > Electrical > LOTO'. */
  headingPath?: string;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  corpusId: string;
  domain: string;
  content: string;
  chunkIndex: number;
  totalChunks: number;
  provenance: ChunkProvenance;
  tokenCount: number;
  vectorId?: string;
  /** Document metadata denormalised onto the chunk, plus section-scoped fields. */
  metadata: Record<string, string | number | boolean>;
}

// ===========================================================================
// Retrieval
// ===========================================================================

/** A chunk returned by retrieval, with its score and enough context to cite. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  /** Score after authority/recency adjustment; what ranking actually used. */
  adjustedScore: number;
  provenance: ChunkProvenance;
  documentTitle?: string;
  documentType?: string;
  revision?: string;
  effectiveDate?: string;
  authority?: string;
  documentStatus?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface RetrievalFilters {
  /** Equality filters applied to Vectorize metadata. */
  [field: string]: string | number | boolean | undefined;
}

export interface RetrievalRequest {
  corpusId: string;
  domain: string;
  query: string;
  topK?: number;
  filters?: RetrievalFilters;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Documents represented in the result set, for the UI's source list. */
  documents: Array<{
    id: string;
    title: string;
    documentType?: string;
    revision?: string;
    effectiveDate?: string;
    status?: string;
  }>;
  latencyMs: number;
}

// ===========================================================================
// Conflicts
// ===========================================================================

/**
 * Two pieces of retrieved evidence that cannot both be acted on.
 *
 * Detected structurally (two active revisions of the same document) and
 * semantically (the model reports a substantive contradiction).
 */
export interface EvidenceConflict {
  kind: 'revision' | 'substantive';
  description: string;
  /** Chunk ids on each side of the conflict. */
  chunkIds: string[];
  documentIds: string[];
}

// ===========================================================================
// Generation
// ===========================================================================

export interface Citation {
  id: string;
  chunkId: string;
  documentId: string;
  citedContent: string;
  documentTitle?: string;
  pageNumber?: number;
  section?: string;
  revision?: string;
  relevanceScore: number;
}

export interface GroundedAnswer {
  id: string;
  corpusId: string;
  domain: string;
  question: string;
  answer: string;
  evidenceStatus: EvidenceStatus;
  /** Status the model proposed, before citation validation constrained it. */
  claimedStatus?: EvidenceStatus;
  confidence: number;
  citations: Citation[];
  /** Evidence that was retrieved, including chunks the answer did not cite. */
  retrievedChunks: RetrievedChunk[];
  missingEvidence: string[];
  conflicts: EvidenceConflict[];
  /** What a human must confirm before acting. Never empty for a real decision. */
  verificationRequired: string[];
  warnings: string[];
  timings: { retrievalMs: number; generationMs: number; totalMs: number };
  usage?: { promptTokens?: number; completionTokens?: number };
  model: string;
  createdAt: string;
}

// ===========================================================================
// Domain pack contract
// ===========================================================================

/**
 * How much a document's own metadata should raise or lower its rank.
 *
 * Authority ranking is domain-agnostic in mechanism but domain-tuned in
 * weight: an approved SOP outranks a draft everywhere, but how strongly a
 * superseded revision should be penalised is a pack-level judgement.
 */
export interface AuthorityWeights {
  /** Multiplier applied to a chunk from a document marked superseded. */
  superseded: number;
  /** Multiplier for a draft/unapproved document. */
  draft: number;
  /** Multiplier for a withdrawn document. */
  withdrawn: number;
  /**
   * Bonus applied to the most recent effective_date among documents sharing a
   * document_type. Expressed as a multiplier > 1.
   */
  mostRecentRevision: number;

  /**
   * **Additive** bonus for a document recording work that is open, in
   * progress, or overdue. Added to the score, not multiplied.
   *
   * Semantic similarity cannot distinguish "the corrective action blocking
   * this job" from "the routine maintenance schedule" — both discuss the same
   * asset in the same vocabulary and score within a few hundredths of each
   * other. An unresolved action is decisive for a readiness question in a way
   * a schedule is not, so this encodes that judgement as a ranking signal,
   * driven by the `actionStatus` field both shipped packs define.
   *
   * Additive because scores in a homogeneous corpus occupy a narrow band; a
   * multiplier big enough to matter there also distorts comparisons it has no
   * business affecting. Keep it small — around 0.02–0.05.
   */
  openAction: number;
}

export interface QueryExample {
  id: string;
  question: string;
  /** Short label for grouping in the UI. */
  category: string;
}

/** A document type the pack recognises, with the label the UI should show. */
export interface DomainDocumentType {
  id: string;
  label: string;
  description: string;
}

export interface DomainPack {
  /** Stable identifier; also the Vectorize namespace. */
  id: string;
  displayName: string;
  description: string;

  /** Document types this domain expects to ingest. */
  documentTypes: DomainDocumentType[];

  /**
   * Zod schema for this domain's document metadata. Applied on ingestion;
   * unknown fields are rejected so a typo cannot silently become a filter
   * that never matches.
   */
  metadataSchema: z.ZodType<Record<string, unknown>>;

  /** Metadata fields offered as retrieval filters in the UI, in order. */
  filterableFields: Array<{ field: string; label: string }>;

  /** Domain vocabulary, injected into the prompt so the model uses house terms. */
  terminology: Record<string, string>;

  /** The domain's grounding and safety instructions. */
  systemPrompt: string;

  /** Section headings the answer should follow, in order. */
  answerStructure: string[];

  /** Representative questions surfaced in the UI. */
  queryExamples: QueryExample[];

  /** Ranking weights for this domain's document lifecycle. */
  authorityWeights: AuthorityWeights;

  /** Default retrieval breadth for this domain. */
  defaultTopK: number;
}
