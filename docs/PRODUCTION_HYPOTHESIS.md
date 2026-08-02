# Production hypothesis and scale path

ORI is a decision-support prototype, not a system of record and not an autonomous approver.
The production hypothesis is narrower and testable:

> For one critical-equipment workflow, a retrieval-and-evidence assistant can cut the time to
> assemble a pre-maintenance readiness review by at least 50% while preserving or improving
> critical-evidence recall, surfacing contradictions, and keeping a qualified person in control.

The goal is not “deploy RAG across the enterprise.” The goal is to earn the right to expand by
measuring one workflow in shadow mode.

## Pilot design

Start with one site, one asset class, and one controlled-document owner. Use 150–300 historical
readiness questions and their source packets to build a gold set before exposing the tool to
live work.

1. **Offline replay (weeks 1–2).** Ingest historical versions, freeze the index, and score
   retrieval, evidence status, citations, missing evidence, and conflicts against reviewer-
   authored labels.
2. **Shadow mode (weeks 3–4).** Reviewers complete the normal process; ORI runs in parallel and
   cannot affect a permit, work order, or approval. Compare time, missed evidence, and false
   alarms.
3. **Assisted mode (weeks 5–6).** Reviewers may use ORI to assemble the packet, but every answer
   links to controlled sources and the existing approval workflow remains authoritative.
4. **Expansion decision.** Add another asset class only if quality gates hold across document
   types, shifts, and reviewers—not because average demo accuracy looks good.

## Promotion gates

Targets are hypotheses to validate, not current claims.

| Dimension | Pilot gate | Why it matters |
|---|---:|---|
| Critical-evidence retrieval recall@20 | ≥ 95% and no high-severity miss in the release set | Generation cannot recover evidence that retrieval omitted |
| Unsupported material-claim rate | < 1%; zero for high-severity claims | Quote origin alone does not prove claim entailment |
| Evidence-status macro F1 | ≥ 0.85 across all four statuses | A system that always abstains can look “safe” while being useless |
| Conflict recall | ≥ 95% on labelled current/superseded and substantive conflicts | Revision ambiguity is the core business risk |
| Exact citation acceptance | 100% for citations shown to users | Enforced mechanically by the current validator |
| Reviewer correction rate | < 10% overall; zero uncorrected critical errors | Measures operational usefulness, not model fluency |
| Median packet-assembly time | ≥ 50% reduction from baseline | The primary business outcome |
| p95 answer latency | < 15s for narrow Q&A; < 30s for synthesis | Separates interactive lookup from heavier review |

Every result is segmented by document type, scan quality, question intent, and evidence status.
A single aggregate score would hide the exact failure modes the system is designed to expose.

## Production architecture

```text
Controlled sources / approved ad-hoc upload
        │
        ▼
malware scan → queue → OCR/extraction → metadata validation → versioned parsed artifact
        │                                      │
        └──────── failures / dead letter ◀─────┘
                                               ▼
                         structure-aware chunks + embedding/index version
                                               ▼
                  tenant + corpus namespace / hybrid dense + lexical index
                                               ▼
query → auth/RBAC → intent → retrieve → metadata/authority rules → rerank/decompose
                                               ▼
                 bounded Mistral structured output → claim/citation validation
                                               ▼
        evidence status + source viewer + human review + immutable audit event
```

### Ingestion

- Move synchronous upload work to a queue with idempotency keys, retries, and a dead-letter
  queue. The request returns a job id; it does not wait for OCR.
- Version the extraction model, chunking configuration, embedding model, and metadata schema.
  A reindex writes to a new index version, validates it, then atomically switches the read
  alias. Deterministic chunk ids alone are not enough because a changed chunking scheme can
  leave obsolete chunks behind.
- Record OCR page/word confidence and route low-confidence pages to human review. Clean sample
  PDFs do not represent scans, rotations, handwriting, signatures, or dense tables.
- Reconcile lifecycle state with the controlled document system. `superseded_by` should come
  from document control, not manual front matter in production.

### Retrieval

- Enforce tenant and corpus scope before ANN search. The prototype now writes new vectors to a
  corpus namespace and retains a temporary legacy-domain fallback only for existing demo data.
- Add lexical retrieval for identifiers, exact procedure numbers, equipment tags, dates, and
  negations; fuse it with dense retrieval and rerank the bounded candidate set.
- Decompose multi-part readiness questions into evidence obligations (permit, isolation,
  findings, actions, spares) and measure recall per obligation.
- Treat metadata quality as a monitored input. Missing subject keys disable structural revision
  detection and must surface as a data-quality warning, not silently disappear.

### Generation and trust

- Keep custom JSON Schema outputs bounded. The prototype's first live run used loose JSON mode,
  reached 4,096 completion tokens, and failed safely; the bounded schema fixed that failure and
  reduced the next readiness run to 1,402 completion tokens.
- Move from an answer-level citation list to claim objects with citation ids. Validate that every
  material claim has support, then run a separate entailment/contradiction check calibrated on
  the domain gold set.
- Never stream a final evidence status before validation. If prose is streamed, label it
  provisional and reveal the status only after citations and conflicts are reconciled.
- Pin model versions for release candidates and benchmark Mistral Small 4 versus Mistral Medium
  3.5 by intent. Model routing is justified only if quality gates remain green.

### Security, governance, and audit

- Authenticate every API call and derive tenant/corpus scope from the identity token—not from a
  client-supplied corpus id. Apply RBAC/ABAC to questions, source documents, and deletion.
- Encrypt in transit and at rest; isolate object prefixes, vector namespaces, and metadata rows;
  define retention, legal hold, deletion verification, and regional processing policies.
- Defend against prompt injection in documents by treating source text as data, delimiting it,
  disallowing source instructions from changing system behavior, and evaluating adversarial
  documents.
- Persist question, retrieved ids/scores, prompt template version, model/version, index version,
  citation rejections, final status, reviewer corrections, and downstream decision reference.
  Avoid storing unnecessary source text twice.

## Reliability and cost

Initial service objectives should distinguish the two workloads:

- narrow Q&A: 99.5% availability, p95 under 15s;
- readiness synthesis: 99.5% availability, p95 under 30s;
- ingestion: 99% of ordinary documents indexed within five minutes, with explicit failed state;
- no cross-tenant retrieval in isolation tests; zero final `SUPPORTED` answers with no verified
  citation.

Cost is measured per successfully reviewed question, not per model call:

```text
cost / reviewed answer = query embedding
                       + generation input/output tokens
                       + amortised OCR and document embeddings
                       + storage/retrieval
                       + human correction time
```

Cache only where corpus version, permissions, question, filters, model, and prompt version all
match. A cheap stale answer is not an optimisation in an operational-readiness workflow.

## Kill switches and rollback

- Disable generation and fall back to source retrieval when citation rejection or parse-failure
  rates breach the release threshold.
- Roll back by model/prompt/index version, not by editing a mutable “latest” configuration.
- Stop assisted use if a critical document is missed, cross-tenant isolation fails, or reviewer
  correction rates exceed the gate. The ordinary review process remains the fallback throughout.
