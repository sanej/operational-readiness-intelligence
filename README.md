# ORI — Operational Readiness Intelligence

**A grounded question-answering system over operational, quality, safety, and compliance
documents — with a readiness-assessment specialisation on top.**

Ask it anything about the corpus and you get a direct, cited answer. Ask it whether work
can proceed and it switches into a fuller assessment: what the evidence establishes, what
is outstanding, what conflicts, and what a qualified person must still verify.

The layering matters and is deliberate:

| Layer | What it is |
|---|---|
| **Foundation** | General question answering. Every answer is grounded in retrieved evidence and cited. |
| **Guarantee** | Citations are verified against the retrieved text, and the evidence status is capped by what survives. |
| **Specialisation** | Readiness, conflict, and synthesis modes, selected by query intent. |

ORI does not approve anything. It never states or implies that equipment, work, production,
a batch, or a regulated process is approved, released, or compliant. That decision belongs
to an authorised human; ORI's job is to put the right evidence, and the right gaps, in
front of them.

Built on Mistral (OCR, embeddings, generation) and Cloudflare (Workers, D1, R2, Vectorize).

---

## The problem

Ask "is Compressor C-101 ready for maintenance?" and the answer lives across seven
documents: an operating procedure, an isolation procedure that has two revisions in force,
an inspection report with open findings, an overdue corrective action, a maintenance manual
with a spares list, and an environmental requirement. A person assembling this by hand takes
hours and can still miss the overdue corrective action.

A naive RAG system does it in seconds and confidently misses the same corrective action — or
worse, answers from a superseded revision, because a superseded procedure describes the same
work in almost the same words as its replacement and matches the query just as well.

ORI is built around the failure modes that matter in this setting:

| Failure | What ORI does |
|---|---|
| Answering from a superseded revision | Authority-aware re-ranking demotes superseded/draft/withdrawn documents and boosts the current revision |
| Two revisions in force, model picks one | Structural conflict detection compares document metadata and forces `CONFLICTING_EVIDENCE` |
| Citing a source that does not say what is claimed | Every quote is verified verbatim against the retrieved chunk; failures are dropped |
| Reporting "supported" on unverifiable evidence | Status is capped by what survived validation — `SUPPORTED` is unreachable with zero verified citations |
| Filling a gap with a plausible guess | Abstention is a first-class outcome, with the missing evidence enumerated |
| Reading as an approval | Prompt constraints plus an eval check that fails on approval language |

---

## Evidence statuses

Every answer resolves to exactly one:

| Status | Meaning |
|---|---|
| `SUPPORTED` | The cited evidence directly and completely answers the question. Not an approval. |
| `PARTIALLY_SUPPORTED` | Part of the question is evidenced; material elements are missing or indirect. |
| `CONFLICTING_EVIDENCE` | Two or more sources disagree and none is clearly authoritative. |
| `INSUFFICIENT_EVIDENCE` | The corpus does not meaningfully address the question. |

**The model proposes a status; the system enforces one.** After generation, every claimed
citation is checked against the chunks actually retrieved — the chunk must be in the
retrieved set, and the quoted text must genuinely appear in it. Citations that fail are
dropped, and the status is capped by what survived. The UI shows both, so a downgrade is
visible rather than silent:

```
EVIDENCE STATUS   PARTIALLY_SUPPORTED
model proposed    SUPPORTED → adjusted by citation validation
```

This is the load-bearing design decision. A `SUPPORTED` from ORI cannot be produced without
at least one quote verified to exist in a retrieved source.

---

## Further reading

| Document | Covers |
|---|---|
| [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md) | Every deliverable, how it was verified, and what is explicitly *not* claimed |
| [docs/MODELS.md](docs/MODELS.md) | Which Mistral model runs where, why, and what is deliberately not an LLM call |
| [docs/INGESTION.md](docs/INGESTION.md) | The upload path end to end — chunking rules, metadata, idempotency |

---

## Architecture

```
┌──────────────┐        ┌──────────────┐
│  Web (Next)  │        │  CLI (tsx)   │     One pipeline, two front doors.
└──────┬───────┘        └──────┬───────┘
       └───────────┬───────────┘
                   ▼
        ┌──────────────────────┐
        │       src/core       │   No industry logic lives here.
        │  ingestion chunking  │
        │  embeddings retrieval│
        │  generation citations│
        │      evaluation      │
        └──────────┬───────────┘
                   │ DomainPack interface
       ┌───────────┴────────────┐
       ▼                        ▼
┌──────────────┐        ┌──────────────┐
│  industrial  │        │    pharma    │   5 files each. Nothing else changes.
└──────────────┘        └──────────────┘
```

**Ingestion:** `R2 (original) → Mistral OCR / direct / structured → normalize → structure-aware
chunk → mistral-embed → Vectorize → D1 (chunks + provenance)`

**Ask:** `embed query → Vectorize (namespace = domain) → corpus + metadata filter in D1 →
authority re-rank → counterpart-revision pass → structural conflict detection →
mistral-large (structured JSON) → citation validation → status enforcement → D1`

### Layout

```
src/
  core/                    # domain-agnostic pipeline
    types.ts               # DomainPack contract, EvidenceStatus, records
    config.ts              # bindings, models, chunking config
    ids.ts                 # WebCrypto content hashing, deterministic ids
    storage.ts             # D1 / R2 / Vectorize clients
    ask.ts                 # the ask pipeline (orchestrator)
    ingestion/             # ocr.ts, normalize.ts, pipeline.ts
    chunking/chunker.ts    # heading-aware splitting with provenance
    embeddings/mistral.ts  # mistral-embed + retry
    retrieval/retrieve.ts  # authority ranking, conflict detection
    generation/generate.ts # prompt assembly, structured output
    citations/validate.ts  # grounding enforcement  ← the important one
    evaluation/harness.ts  # eval checks
  domains/
    industrial/            # config, metadata-schema, system-prompt,
    pharma/                #   query-examples, evals.json
    index.ts               # registry
  app/                     # Next.js UI + API routes
  components/              # answer panel, evidence status, document list
scripts/                   # ingest.ts, ask.ts, eval.ts
sample-documents/          # synthetic corpora, both domains
migrations/                # D1 schema
```

---

## Domain composability

The shared pipeline contains no industry vocabulary. A domain pack supplies:

| Field | Purpose |
|---|---|
| `displayName`, `description` | UI |
| `documentTypes` | Recognised document vocabulary |
| `metadataSchema` | Zod schema, **strict** — unknown fields are rejected on ingestion |
| `filterableFields` | Retrieval filters offered in the UI |
| `terminology` | Injected into the prompt so the model uses house terms |
| `systemPrompt` | What a competent reviewer in this field looks for |
| `answerStructure` | Section headings the answer follows |
| `queryExamples` | Representative questions |
| `authorityWeights` | How hard to penalise superseded/draft documents |
| `defaultTopK` | Retrieval breadth |

Adding pharmaceutical manufacturing required **five files and one registry line** — zero
changes to `src/core`. Weights differ meaningfully between packs: pharma penalises a
superseded SOP harder (0.35 vs 0.45) because acting on a stale SOP in a GMP setting is
itself a deviation.

Metadata schemas are `.strict()` deliberately. A typo like `assetID` would otherwise be
stored silently, produce a filter that never matches, and surface much later as an
inexplicable retrieval bug.

---

## Quick start

### Prerequisites

- Node.js 20+
- A Cloudflare account (D1, R2, Vectorize — all within free tier for this demo)
- A Mistral API key — <https://console.mistral.ai/>

### 1. Install and authenticate

```bash
npm install
```

```bash
npx wrangler login
```

### 2. Provision Cloudflare resources

```bash
npx wrangler d1 create ori-db-dev
```

```bash
npx wrangler r2 bucket create ori-documents-dev
```

```bash
npx wrangler vectorize create ori-vectors-dev --dimensions=1024 --metric=cosine
```

Copy the `database_id` from the D1 output into `wrangler.toml`.

> `--dimensions=1024` must match `mistral-embed`. A mismatch fails loudly at ingestion
> rather than silently producing a broken index.

### 3. Configure secrets

```bash
cp .dev.vars.example .dev.vars
```

Put your key in `.dev.vars` (git-ignored):

```
MISTRAL_API_KEY="your-key-here"
```

`MISTRAL_API_KEY` is deliberately **not** in `wrangler.toml` — `[vars]` ships in plaintext
with the Worker. For production use `npx wrangler secret put MISTRAL_API_KEY`.

### 4. Apply the schema

```bash
npm run db:migrate:remote
```

### 5. Ingest the sample corpora

```bash
npm run ingest -- ./sample-documents/industrial
```

```bash
npm run ingest -- ./sample-documents/pharma
```

### 6. Ask something

```bash
npm run ask
```

Or run the web app:

```bash
npm run preview
```

> Use `npm run preview` (wrangler), not `npm run dev`. Only the Workers runtime provides the
> D1/R2/Vectorize bindings; `next dev` fails with a clear `MissingBindingsError`.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run ingest -- <dir>` | Ingest a directory. Domain inferred from the folder name. |
| `npm run ask` | Interactive Q&A. `-- --domain pharma`, or pass a question directly. |
| `npm run ask -- --examples` | List the domain's example questions. |
| `npm run eval` | Run the evaluation suites. `-- --domain industrial` for one. |
| `npm test` | Unit tests (pure logic — no network). |
| `npm run type-check` | TypeScript, no emit. |
| `npm run preview` | Build and serve on the Workers runtime. |
| `npm run deploy` | Deploy to Cloudflare. |

The CLI and web app share the same `IngestionPipeline` and `AskPipeline`. `getPlatformProxy`
gives Node the same bindings the Worker uses, and because they are declared `remote = true`,
both operate on the same live D1, R2, and Vectorize.

---

## Environment variables

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `MISTRAL_API_KEY` | `.dev.vars` / `wrangler secret` | — | **Required.** Never in `wrangler.toml`. |
| `MISTRAL_EMBED_MODEL` | `wrangler.toml` | `mistral-embed` | 1024-d embeddings |
| `MISTRAL_CHAT_MODEL` | `wrangler.toml` | `mistral-large-latest` | Answer generation |
| `MISTRAL_OCR_MODEL` | `wrangler.toml` | `mistral-ocr-latest` | Document extraction |
| `CHUNK_TARGET_TOKENS` | `wrangler.toml` | `512` | Target chunk size |
| `CHUNK_OVERLAP_TOKENS` | `wrangler.toml` | `100` | Window overlap |
| `RETRIEVAL_TOP_K` | `wrangler.toml` | `8` | Default retrieval breadth |

---

## Deployment

```bash
npx wrangler secret put MISTRAL_API_KEY
```

```bash
npm run deploy
```

For a separate production environment, create `ori-db-prod` / `ori-documents-prod` /
`ori-vectors-prod`, add an `[env.production]` block to `wrangler.toml`, and run
`npm run deploy -- --env production`.

---

## Design decisions

**Grounding is enforced by the system, not requested in a prompt.**
A model asked to cite its sources will sometimes cite a chunk that was never retrieved, or
quote text that is not in the chunk it names. Both produce an answer that looks sourced and
is not. `core/citations/validate.ts` checks every citation against the retrieved set and
caps the status by what survives. It is pure — no network, no provider types — and carries
the densest test coverage in the project.

**Conflict detection is structural first, semantic second.**
The model reads chunks; it cannot see that two documents are competing revisions unless both
happen to be retrieved and it notices. Comparing document metadata catches this
deterministically. During development the model missed exactly this case and structural
detection caught it — which is why retrieval also runs a *counterpart-revision pass*: if a
selected chunk's document has a competing active revision, that revision's best chunk is
pulled in, so the contradiction is visible rather than luck-dependent.

**General Q&A is the default; readiness is a specialisation.**
The first build applied the readiness structure to every question. Asking "which are the
critical failure paths?" returned a six-section report — summary, outstanding items,
conflicts, missing evidence, verification — when the question wanted a list. Worse, the
retrieved set contained two competing revisions of an unrelated isolation procedure, so the
answer came back `CONFLICTING_EVIDENCE` at 0.60 confidence for a question the conflict had
no bearing on.

A keyword classifier now routes each question to one of `GENERAL_QA`, `SYNTHESIS`,
`CONFLICT_CHECK`, or `READINESS_ASSESSMENT`, which selects the answer's section structure
and the instructions layered onto the domain prompt. The same question now returns
`SUPPORTED` at 0.98 with a two-section answer.

Rules rather than a model call, because the blast radius is formatting: intent does not
touch retrieval, generation, or the citation guarantee, so a misclassification costs a
slightly ill-fitting shape, never a wrong fact. The bias is toward the narrower structure —
a readiness question answered in general-QA shape still surfaces the evidence and the
conflicts, while a factual lookup answered as a report buries the answer.

**Evidence support is counted, not asserted.**
The interface shows an evidence-support score derived from what survived
validation — how many citations the model offered, how many verified against the
retrieved text, and how many distinct documents those reach. It deliberately
replaces the model's self-reported confidence, which is not calibrated against
anything: a 0.98 and a 0.62 from the same model do not reliably differ in
accuracy, and displaying one invites a reader to treat it as a measurement. The
model's confidence is still written to D1 for audit; it is simply not what the
interface presents.

**Conflicts are filtered by materiality.**
Two revisions of an isolation procedure are retrieved for almost any question about the asset
they cover. Reporting a conflict every time would make the signal worthless — a warning that
fires on routine questions is one a reviewer learns to dismiss. A conflict is therefore
reported only when the answer actually cited **both** sides. Retrieval position turned out to
be a poor proxy: long procedures rank highly on topic alone, and gating on rank still produced
`CONFLICTING_EVIDENCE` for "what are the vibration alarm setpoints?" — a question one document
answers unambiguously. The same test is applied to the model's own conflict claims, which it
will otherwise report faithfully but irrelevantly. Setpoints now returns `SUPPORTED` (0.98);
isolation requirements returns `CONFLICTING_EVIDENCE`.

**Ranking signals are additive, not multiplicative.**
Similarity scores in a homogeneous corpus sit in a narrow band — roughly 0.75–0.85 here. A
multiplier large enough to promote an unresolved corrective action through that band also
reorders documents that have nothing to do with each other: at one point a 1.25× boost pushed
the single most relevant procedure into last place despite holding the highest raw score. The
`openAction` signal is a small additive bonus (0.03–0.04) that breaks ties where scores are
genuinely close and leaves a clear relevance win intact. Relatedly, the most-recent-revision
boost only applies where a competing revision actually exists — applying it to every document
that is trivially the newest of its own group boosts everything equally, which is not a
ranking signal at all.

**Lifecycle penalties apply only where an alternative exists.**
Demoting a draft is right when a current version exists to use instead. But a draft, unsigned
permit is the *authoritative record* of the fact that it has not been signed — penalising it
buried exactly the evidence that answers "has this been authorised?". Penalties now apply only
to documents that have an active alternative covering the same subject.

**Metadata filtering happens in D1, not Vectorize.**
Vectorize only filters on metadata fields with an explicitly created metadata index, and a
filter on an unindexed field returns **zero matches rather than an error** — a failure mode
indistinguishable from "no relevant evidence exists". This cost real debugging time during
development. Filtering against D1, which is authoritative for document metadata anyway, is
correct by construction and needs no index management. Domain isolation still uses Vectorize
namespaces, which work natively and were verified to isolate cleanly.

**Chunking follows document structure, not token windows.**
A citation is only actionable if it names the section it came from. Chunks split on Markdown
headings and carry a heading path (`SP-204 > 2. Isolation Requirements`). Chunks never merge
across pages or top-level sections, and a chunk spanning several subsections is attributed to
their deepest *common* ancestor rather than the first — attributing a chunk covering §2.1–§2.3
to "§2.1" would point a reviewer at the wrong place. The first implementation produced 13
chunks for 7 documents, nearly all labelled with just the document title; the current one
produces 43, each addressable to a real section.

**WebCrypto, not `node:crypto`.**
One implementation serves both the Worker and the Node CLI, so ingestion cannot diverge
between them. All ids are pure functions of their inputs, which makes re-ingestion idempotent:
the same file in the same corpus upserts in place rather than duplicating the corpus.

**No LLM-as-judge in the evaluation harness.**
Every check is mechanical — status, retrieved documents, citation counts, conflict presence,
approval-language regexes. A model judging another model's output would share the failure
modes being tested for.

**Approximate token counting.**
A real BPE tokenizer means native binaries or a large WASM blob in the Workers bundle. Chunk
sizing only needs to be consistent, not exact.

---

## Evaluation

```bash
npm run eval
```

Seven cases per domain covering: correct source retrieval, authoritative revision retrieval,
multi-document synthesis, citation support, unsupported-answer abstention, missing-information
detection, and conflicting-document detection. Latency and token usage are recorded per case,
and results are written to `evaluation_runs` / `evaluation_records` in D1 so runs can be
compared over time.

Results are reported per dimension, so a failure says which capability regressed. Current
state — **14/14 passing**, all dimensions green in both domains:

```
Industrial Operations  7/7 passed
  latency  p50 39563 ms · p95 53802 ms · mean 38012 ms · max 53802 ms
  tokens   36845 prompt · 19608 completion · 56453 total

Pharmaceutical Manufacturing  7/7 passed
  latency  p50 39752 ms · p95 60881 ms · mean 38362 ms · max 60881 ms
  tokens   33796 prompt · 19637 completion · 53433 total

  by dimension (each domain)
    authoritative_revision             1/1
    citation_support                   4/4
    conflicting_document_detection     1/1
    correct_source_retrieval           2/2 – 3/3
    missing_information                3/3
    multi_document_synthesis           2/2
    unsupported_answer_abstention      1/1
```

Unit tests (`npm test`) cover the pure logic: citation validation, status enforcement,
chunking provenance, structured-output parsing, and the domain-pack contract. Anything
requiring D1, R2, Vectorize, or Mistral is covered by the eval harness against the live
stack — mocking those would test the mocks rather than the integration.

One eval case is worth noting because it changed during development. The abstention cases
originally asserted *zero* citations. In practice the system abstains and cites the evidence
that demonstrates *why* it is abstaining — quoting the PX-200-2604 batch record to show it is
a different batch from the one asked about. That is better behaviour than citation-free
abstention, because it shows what was checked. The assertion was wrong, not the system.

### Sample corpora

Sixteen synthetic documents across two domains — fourteen Markdown and one PDF per domain.
Fictional sites, assets, products, and batches; no confidential, proprietary, patient, or
personally identifiable information.

Markdown files carry their metadata as YAML front matter. The PDFs cannot, so they use a
`<name>.meta.json` sidecar, validated by the domain pack exactly like front matter. The PDFs
exist so the Mistral OCR path is exercised end to end rather than merely present: both extract
in about 5 seconds, and Mistral OCR preserves heading hierarchy and table structure well
enough that the structure-aware chunker builds correct heading paths from the output.

Each corpus contains three deliberate cases:

| Case | Industrial | Pharma |
|---|---|---|
| **Conflicting revisions** | SP-204 Rev 6 and Rev 7 both active; Rev 6 mandates spading, Rev 7 permits double block and bleed | SOP-CL-004 Rev 3 and Rev 4 both effective; 72h vs 120h hold time, 6 vs 4 swab locations |
| **Unresolved corrective action** | CA-2026-031 overdue, no outage window allocated | CAPA-2026-019 overdue, no action complete |
| **Missing evidence** | Internal casing inspection never performed; thrust bearing at zero stock | SOP Rev 4 cites "VP-CL-2024-09 Addendum 1" — no such document exists |

---

## Known limitations

- **Dense retrieval only.** No BM25 and no reranker. Exact-identifier lookups ("show me
  CA-2026-031") lean on the identifier appearing in surrounding text. The retrieval interface
  is shaped so hybrid scoring and a reranking stage slot in as additional scoring stages
  without changing callers.
- **Latency is 20–60s per question.** Dominated by `mistral-large-latest` generating a
  structured answer with citations. No streaming, so the UI shows a skeleton for the full
  duration.
- **Conflict detection needs metadata.** Documents without `documentType` and a subject key
  (asset, equipment, SOP number) cannot be grouped into revision families. Structural
  detection then silently does nothing and only the model's semantic detection remains.
- **Quote matching is lexical.** Normalised containment, plus an 80% content-word overlap
  allowance for long quotes. A faithful paraphrase is rejected — deliberately biased toward
  false rejection over false acceptance.
- **Front matter parsing is minimal.** Flat `key: value` pairs and simple lists, not a full
  YAML parser.
- **No incremental re-index.** Changing chunking configuration requires re-ingestion. Ids are
  deterministic so this upserts in place, but chunks orphaned by a previous chunking scheme
  are not garbage-collected.
- **Single corpus per domain in the UI.** The schema and pipeline support many; the UI uses
  the conventional `<domain>-demo` id.
- **OCR is exercised but not benchmarked at scale.** Two PDFs in the sample corpus go through
  Mistral OCR on every ingest, and quality on those is good. It has not been tested against
  scanned, rotated, or handwritten documents, which is where OCR usually degrades.

---

## Production roadmap

**Retrieval quality** — hybrid dense + BM25; a reranking pass over the over-fetched candidate
set; query decomposition for multi-part readiness questions; tuning authority weights per
domain against a larger eval set.

**Latency** — stream the answer while validating citations server-side; cache query
embeddings; use a smaller model for classification-shaped questions and reserve
`mistral-large` for synthesis.

**Ingestion** — move to Cloudflare Queues so a large upload does not block a request; a
document supersession workflow that maintains `superseded_by` automatically; table-aware
chunking so a specification table is never split mid-row.

**Trust and audit** — surface rejected-citation detail in the UI, not just the count; link
citations to a page-anchored viewer over the R2 original; retain the full prompt and retrieved
set per answer for audit replay.

**Extension points designed for, deliberately not built:** authentication and multi-tenancy
(corpus is already the isolation boundary), workflow dashboards, notifications, scheduled
monitoring, collaboration. Each sits above the current pipeline rather than requiring changes
to it.

---

## Provenance

The application shell, Cloudflare provider layer, Mistral embedding client, and the
citation-validation approach were adapted from **Proofcase**, an earlier Mistral + Cloudflare
RAG project in this workspace. That repository is unmodified. Three defects were fixed rather
than carried over: OCR reading `process.env` at module scope (undefined on Workers),
`node:crypto` in the ingestion path (which would force CLI and Worker to diverge), and a Q&A
service that returned all chunks for most question types instead of retrieving semantically.

## Disclaimer

ORI is a decision-support tool operating on synthetic demonstration data. It does not approve
work, release batches, certify conformity, or make any regulatory determination. It has not
been validated as a system of record for any regulated purpose. All output requires review by
a qualified person against the controlled source documents.
