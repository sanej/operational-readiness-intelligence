// Retrieval: semantic search, then authority-aware re-ranking.
//
// Plain cosine similarity is not enough for operational documents, because the
// most semantically similar chunk is frequently the *wrong revision*. A
// superseded procedure describes the same work in the same words as the
// current one — it will match a query just as well, and acting on it is
// exactly the failure ORI exists to prevent.
//
// So scores are adjusted by document lifecycle before ranking: superseded,
// draft and withdrawn documents are penalised, and the most recent revision of
// each document type is boosted. Weights come from the domain pack, because
// how hard to penalise a draft is a domain judgement.
//
// The interface is deliberately shaped so hybrid retrieval (BM25 + dense) and
// a reranker model can be inserted as extra scoring stages later without
// changing callers.

import type { MistralConfig } from '../config';
import type { EmbeddingService } from '../embeddings/mistral';
import { vectorNamespace, type D1Store, type VectorStore, type DocumentRow, type ChunkRow } from '../storage';
import type {
  AuthorityWeights,
  EvidenceConflict,
  RetrievalFilters,
  RetrievalResult,
  RetrievedChunk,
} from '../types';

export interface RetrieveOptions {
  corpusId: string;
  domain: string;
  query: string;
  topK: number;
  filters?: RetrievalFilters;
  authorityWeights: AuthorityWeights;
}

export class RetrievalService {
  constructor(
    private readonly d1: D1Store,
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingService,
    private readonly _mistral: MistralConfig
  ) {}

  async retrieve(opts: RetrieveOptions): Promise<RetrievalResult> {
    const started = Date.now();

    const queryVector = await this.embeddings.embedOne(opts.query);

    // Over-fetch before re-ranking and filtering: a current revision sitting
    // just outside topK on raw similarity should still be able to win after
    // the authority adjustment promotes it, and metadata filters are applied
    // after the vector search (see below), so they need headroom too.
    const activeFilters = Object.entries(opts.filters ?? {}).filter(
      ([, value]) => value !== undefined && value !== ''
    );
    const fetchK = Math.min(opts.topK * (activeFilters.length > 0 ? 8 : 3), 100);

    // Isolation is by namespace (one per corpus), which Vectorize enforces
    // natively. Field-level filtering is deliberately NOT pushed into the
    // vector query: Vectorize only filters on metadata fields that have an
    // explicitly created metadata index, and a filter on an unindexed field
    // silently returns zero matches rather than erroring — a failure mode that
    // looks exactly like "no relevant evidence exists". Filtering against D1,
    // which is authoritative for document metadata anyway, is correct by
    // construction and needs no per-field index management.
    const namespace = vectorNamespace(opts.domain, opts.corpusId);
    const primaryMatches = await this.vectors.query(queryVector, {
      topK: fetchK,
      namespace,
    });

    // Migration compatibility for corpora indexed before corpus namespaces
    // were introduced. Query the legacy domain namespace only while the new
    // namespace has not filled the requested candidate window, then de-duplicate
    // by vector id. Re-ingestion writes exclusively to the corpus namespace.
    // This keeps the live prototype usable while ensuring new corpora cannot be
    // crowded out by another corpus before D1 scoping is applied.
    let matches = primaryMatches;
    if (primaryMatches.length < fetchK) {
      const legacyMatches = await this.vectors.query(queryVector, {
        topK: fetchK,
        namespace: opts.domain,
      });
      const merged = new Map(primaryMatches.map((match) => [match.id, match]));
      for (const match of legacyMatches) {
        const current = merged.get(match.id);
        if (!current || match.score > current.score) merged.set(match.id, match);
      }
      matches = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, fetchK);
    }

    if (matches.length === 0) {
      return { chunks: [], documents: [], latencyMs: Date.now() - started };
    }

    // Vectorize metadata is a projection; D1 holds the authoritative text.
    const rows = await this.d1.getChunksByVectorIds(matches.map((m) => m.id));
    const rowByVectorId = new Map(rows.map((r) => [r.vector_id!, r]));

    const documentIds = [...new Set(rows.map((r) => r.document_id))];
    const documentRows = await this.d1.getDocumentsByIds(documentIds);
    const documents = new Map<string, DocumentRow>(documentRows.map((doc) => [doc.id, doc]));

    const allDocs = [...documents.values()];
    const latestByType = mostRecentByDocumentType(allDocs);
    const penalisable = documentsWithAuthoritativeAlternative(allDocs);

    const chunks: RetrievedChunk[] = [];

    for (const match of matches) {
      const row = rowByVectorId.get(match.id);
      if (!row) continue;

      // Corpus scoping. The namespace already isolates the domain; this keeps
      // separate corpora within one domain from bleeding into each other.
      if (row.corpus_id !== opts.corpusId) continue;

      const doc = documents.get(row.document_id);

      if (!matchesFilters(row, doc, activeFilters)) continue;

      const multiplier = authorityMultiplier(
        doc,
        latestByType,
        opts.authorityWeights,
        doc ? penalisable.has(doc.id) : false
      );

      chunks.push({
        chunkId: row.id,
        documentId: row.document_id,
        content: row.content,
        score: match.score,
        adjustedScore: match.score * multiplier + openActionBonus(doc, opts.authorityWeights),
        provenance: {
          pageNumber: row.page_number ?? undefined,
          section: row.section ?? undefined,
          headingPath: row.heading_path ?? undefined,
        },
        documentTitle: doc?.title ?? doc?.original_file_name,
        documentType: doc?.document_type ?? undefined,
        revision: doc?.revision ?? undefined,
        effectiveDate: doc?.effective_date ?? undefined,
        authority: doc?.authority ?? undefined,
        documentStatus: doc?.doc_status ?? undefined,
        metadata: JSON.parse(row.metadata || '{}'),
      });
    }

    chunks.sort((a, b) => b.adjustedScore - a.adjustedScore);
    const top = chunks.slice(0, opts.topK);

    // Conflict detection must not depend on both revisions happening to land
    // in the same top-k. If a selected chunk's document has a competing active
    // revision elsewhere in the candidate pool, pull that revision's best
    // chunk in as well. Otherwise the single most common failure — answering
    // confidently from one of two contradicting procedures — stays invisible
    // precisely when the two agree closely enough to rank together.
    const counterparts = findCounterpartRevisions(top, chunks, documents, opts.topK);
    top.push(...counterparts);

    const representedDocs = [...new Set(top.map((c) => c.documentId))]
      .map((id) => documents.get(id))
      .filter((d): d is DocumentRow => Boolean(d))
      .map((d) => ({
        id: d.id,
        title: d.title ?? d.original_file_name,
        documentType: d.document_type ?? undefined,
        revision: d.revision ?? undefined,
        effectiveDate: d.effective_date ?? undefined,
        status: d.doc_status ?? undefined,
      }));

    return { chunks: top, documents: representedDocs, latencyMs: Date.now() - started };
  }
}

/**
 * Group key identifying "the same document, different revision".
 *
 * Documents conflict when they are the same type about the same subject. The
 * subject is the domain's natural key — asset, equipment, SOP number — which
 * lives in the metadata JSON, so this reads whichever the domain populated.
 */
function revisionGroupKey(doc: DocumentRow): string | null {
  if (!doc.document_type) return null;

  const extra = JSON.parse(doc.metadata || '{}') as Record<string, unknown>;
  const subject =
    (extra.reference as string) ??
    (extra.sopNumber as string) ??
    (extra.assetId as string) ??
    (extra.equipmentId as string) ??
    (extra.productCode as string) ??
    '';

  if (!subject) return null;
  return `${doc.document_type}::${subject}`;
}

/**
 * Find chunks from competing active revisions of documents already selected.
 *
 * Returns at most one chunk per competing revision, and caps the total so a
 * corpus with many revisions cannot crowd out the primary results.
 */
function findCounterpartRevisions(
  selected: RetrievedChunk[],
  pool: RetrievedChunk[],
  documents: Map<string, DocumentRow>,
  topK: number
): RetrievedChunk[] {
  const selectedIds = new Set(selected.map((c) => c.chunkId));
  const selectedDocIds = new Set(selected.map((c) => c.documentId));

  // Revision groups represented in the selected set, with the docs chosen.
  const groups = new Map<string, Set<string>>();
  for (const docId of selectedDocIds) {
    const doc = documents.get(docId);
    if (!doc || doc.doc_status === 'superseded') continue;

    const key = revisionGroupKey(doc);
    if (!key) continue;

    const set = groups.get(key) ?? new Set<string>();
    set.add(docId);
    groups.set(key, set);
  }

  // Best score achieved by each revision group in the selected set, and the
  // best score overall. A counterpart is only worth adding when its group is
  // genuinely central to this question — otherwise a document that merely
  // scraped into the results drags its competing revision in behind it and
  // manufactures a conflict on a question neither revision is really about.
  const bestScoreByGroup = new Map<string, number>();
  let bestOverall = 0;

  for (const chunk of selected) {
    bestOverall = Math.max(bestOverall, chunk.adjustedScore);

    const doc = documents.get(chunk.documentId);
    if (!doc) continue;
    const key = revisionGroupKey(doc);
    if (!key) continue;
    bestScoreByGroup.set(key, Math.max(bestScoreByGroup.get(key) ?? 0, chunk.adjustedScore));
  }

  const additions: RetrievedChunk[] = [];
  const addedDocs = new Set<string>();
  const maxAdditions = Math.max(2, Math.ceil(topK / 4));

  // Pool is already sorted by adjustedScore, so the first hit per document is
  // that document's best-matching chunk.
  for (const chunk of pool) {
    if (additions.length >= maxAdditions) break;
    if (selectedIds.has(chunk.chunkId)) continue;
    if (selectedDocIds.has(chunk.documentId) || addedDocs.has(chunk.documentId)) continue;

    const doc = documents.get(chunk.documentId);
    if (!doc || doc.doc_status === 'superseded') continue;

    const key = revisionGroupKey(doc);
    if (!key) continue;

    const competing = groups.get(key);
    if (!competing || competing.has(chunk.documentId)) continue;

    // Relevance gates. Two revisions only conflict *on this question* if both
    // actually speak to it. Without these, asking about a vibration setpoint
    // documented unambiguously in one procedure drags in an unrelated
    // procedure's competing revision and reports a conflict that does not
    // exist — noise that teaches a reviewer to ignore the conflict signal.
    const rival = bestScoreByGroup.get(key) ?? 0;

    // (a) the group must be central to the question, not incidental to it;
    if (rival < bestOverall * 0.9) continue;

    // (b) the counterpart must be competitive with the side already selected.
    if (chunk.adjustedScore < rival * 0.85) continue;

    additions.push(chunk);
    addedDocs.add(chunk.documentId);
  }

  return additions;
}

/**
 * Apply domain-pack metadata filters to a candidate chunk.
 *
 * Fields are looked up first on the promoted document columns, then in the
 * document's metadata JSON, then on the chunk's own metadata. Comparison is
 * case-insensitive string equality, which is what the UI's filter controls
 * produce.
 */
function matchesFilters(
  row: ChunkRow,
  doc: DocumentRow | undefined,
  filters: Array<[string, string | number | boolean | undefined]>
): boolean {
  if (filters.length === 0) return true;

  const docExtra = doc ? (JSON.parse(doc.metadata || '{}') as Record<string, unknown>) : {};
  const chunkExtra = JSON.parse(row.metadata || '{}') as Record<string, unknown>;

  const promoted: Record<string, unknown> = {
    documentType: doc?.document_type,
    revision: doc?.revision,
    effectiveDate: doc?.effective_date,
    authority: doc?.authority,
    status: doc?.doc_status,
    docStatus: doc?.doc_status,
    title: doc?.title,
  };

  return filters.every(([field, expected]) => {
    const actual = promoted[field] ?? docExtra[field] ?? chunkExtra[field];
    if (actual === undefined || actual === null) return false;
    return String(actual).toLowerCase() === String(expected).toLowerCase();
  });
}

/**
 * The subject a document is *about*, from its domain metadata.
 *
 * Exported so every place that decides "are these two documents alternatives
 * for one another" agrees. `reference` comes first because it is the document
 * number (SP-204, SOP-CL-004) — two revisions of one procedure share it, while
 * unrelated documents about the same asset do not.
 */
export function documentSubject(metadata: Record<string, unknown>): string {
  return (
    (metadata.reference as string) ??
    (metadata.sopNumber as string) ??
    (metadata.assetId as string) ??
    (metadata.equipmentId as string) ??
    (metadata.productCode as string) ??
    ''
  );
}

/** Subject key used to group documents that are alternatives for one another. */
function subjectKey(doc: DocumentRow): string {
  const extra = JSON.parse(doc.metadata || '{}') as Record<string, unknown>;
  return `${doc.document_type ?? ''}::${documentSubject(extra)}`;
}

/**
 * Which documents have an *active* alternative covering the same subject.
 *
 * Only these should be penalised for their lifecycle state — a superseded
 * procedure matters less because a current one exists. Where no alternative
 * exists, the document stands as the only record of its subject.
 */
function documentsWithAuthoritativeAlternative(docs: DocumentRow[]): Set<string> {
  const activeBySubject = new Map<string, string[]>();

  for (const doc of docs) {
    if (doc.doc_status && doc.doc_status !== 'active') continue;
    const key = subjectKey(doc);
    activeBySubject.set(key, [...(activeBySubject.get(key) ?? []), doc.id]);
  }

  const result = new Set<string>();
  for (const doc of docs) {
    if (!doc.doc_status || doc.doc_status === 'active') continue;
    const alternatives = (activeBySubject.get(subjectKey(doc)) ?? []).filter((id) => id !== doc.id);
    if (alternatives.length > 0) result.add(doc.id);
  }

  return result;
}

/**
 * For each document_type, which document has the latest effective_date.
 *
 * Used to boost the current revision over its predecessors. Only meaningful
 * where documents actually carry effective dates; without them the boost
 * simply never applies.
 */
function mostRecentByDocumentType(docs: DocumentRow[]): Map<string, string> {
  const groups = new Map<string, DocumentRow[]>();

  for (const doc of docs) {
    if (!doc.document_type || !doc.effective_date) continue;
    // Key on type + subject so unrelated documents do not compete for
    // "most recent".
    const key = subjectKey(doc);
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }

  const result = new Map<string, string>();

  for (const [key, members] of groups) {
    // A boost for "most recent" is only meaningful when there is something to
    // be more recent *than*. Applying it to every document that happens to be
    // the sole member of its group boosts everything equally — which is not a
    // ranking signal at all, and lets a weakly-matching document outrank a
    // strongly-matching one purely on multiplier arithmetic.
    if (members.length < 2) continue;

    const latest = members.reduce((a, b) =>
      (b.effective_date ?? '') > (a.effective_date ?? '') ? b : a
    );
    result.set(key, latest.id);
  }

  return result;
}

function authorityMultiplier(
  doc: DocumentRow | undefined,
  latestByType: Map<string, string>,
  weights: AuthorityWeights,
  hasAuthoritativeAlternative: boolean
): number {
  if (!doc) return 1;

  let multiplier = 1;

  // Lifecycle penalties exist to stop a stale document being followed as an
  // instruction when a current one exists. They must not suppress a document
  // that is the only record of its own subject: a draft, unsigned permit is
  // unreliable as a source of *requirements*, but it is the authoritative
  // record of the fact that it has not been signed. Penalising it would hide
  // exactly the evidence that answers "has this been authorised?".
  if (hasAuthoritativeAlternative) {
    switch (doc.doc_status) {
      case 'superseded':
        multiplier *= weights.superseded;
        break;
      case 'draft':
        multiplier *= weights.draft;
        break;
      case 'withdrawn':
        multiplier *= weights.withdrawn;
        break;
    }
  }

  if ([...latestByType.values()].includes(doc.id)) {
    multiplier *= weights.mostRecentRevision;
  }

  return multiplier;
}

/**
 * Additive bonus for a document recording work that is open or overdue.
 *
 * Deliberately additive rather than multiplicative. Similarity scores in a
 * homogeneous corpus sit in a narrow band (roughly 0.75–0.85 here), so a
 * multiplier large enough to promote an unresolved action past that band also
 * reorders documents that have nothing to do with each other — at one point it
 * pushed the single most relevant procedure to last place. A small additive
 * nudge changes the order where scores are genuinely close, which is exactly
 * where the domain signal should decide, and leaves a clear relevance win
 * intact.
 */
function openActionBonus(doc: DocumentRow | undefined, weights: AuthorityWeights): number {
  if (!doc) return 0;

  const extra = JSON.parse(doc.metadata || '{}') as Record<string, unknown>;
  const actionStatus = extra.actionStatus;

  if (actionStatus === 'open' || actionStatus === 'in_progress' || actionStatus === 'overdue') {
    return weights.openAction;
  }
  return 0;
}

/**
 * Structural conflict detection.
 *
 * Finds the case a model reading chunk-by-chunk reliably misses: two documents
 * of the same type, about the same subject, both presented as current, with
 * different revisions. Whether their *content* contradicts is a semantic
 * question left to the model; this catches the case where the corpus itself is
 * inconsistent, which is detectable from metadata alone and should be reported
 * even when the retrieved text happens to agree.
 */
export function detectRevisionConflicts(
  chunks: RetrievedChunk[],
  documentsById: Map<string, { documentType?: string; revision?: string; status?: string; title?: string; subject?: string }>
): EvidenceConflict[] {
  const groups = new Map<
    string,
    Array<{ documentId: string; revision: string; title: string; chunkIds: string[] }>
  >();

  for (const chunk of chunks) {
    const doc = documentsById.get(chunk.documentId);
    if (!doc?.documentType || !doc.revision) continue;

    // A document explicitly marked superseded is not a conflict — the corpus
    // is telling us which one wins. Only competing *active* revisions conflict.
    if (doc.status && doc.status !== 'active') continue;

    const key = `${doc.documentType}::${doc.subject ?? ''}`;
    const list = groups.get(key) ?? [];

    const existing = list.find((e) => e.documentId === chunk.documentId);
    if (existing) {
      existing.chunkIds.push(chunk.chunkId);
    } else {
      list.push({
        documentId: chunk.documentId,
        revision: doc.revision,
        title: doc.title ?? chunk.documentId,
        chunkIds: [chunk.chunkId],
      });
    }

    groups.set(key, list);
  }

  const conflicts: EvidenceConflict[] = [];

  for (const [, entries] of groups) {
    const revisions = new Set(entries.map((e) => e.revision));
    if (entries.length < 2 || revisions.size < 2) continue;

    const described = entries.map((e) => `${e.title} (${e.revision})`).join(' and ');

    conflicts.push({
      kind: 'revision',
      description:
        `Multiple active revisions of the same document type were retrieved: ${described}. ` +
        `Neither is marked superseded, so the authoritative revision must be confirmed before acting.`,
      chunkIds: entries.flatMap((e) => e.chunkIds),
      documentIds: entries.map((e) => e.documentId),
    });
  }

  return conflicts;
}
