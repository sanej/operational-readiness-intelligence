# Definition of Done

What was built, how it was verified, and what was deliberately left out.

Everything marked **Done** was run, not just written. Where a claim rests on a
measurement, the measurement is named. Where something was not verified, it is
listed under [Not claimed](#not-claimed) rather than quietly counted as done.

Last verified: 2026-07-31, against the live `ori-db-dev` / `ori-documents-dev` /
`ori-vectors-dev` resources.

---

## Summary

| Check | Result |
|---|---|
| Evaluation harness | **14/14** cases passing, all 7 dimensions green in both domains |
| Unit tests | **70/70** passing |
| TypeScript | clean (`tsc --noEmit`) |
| Lint | clean (`eslint`) |
| Production build | succeeds (`next build` + `opennextjs-cloudflare build`) |
| Live stack | D1, R2, Vectorize, Mistral OCR / embeddings / generation all exercised |

---

## The eleven deliverables

### 1. Working full-stack application — **Done**

Next.js 16 on Cloudflare Workers via `@opennextjs/cloudflare`. Four API routes
(`/api/domains`, `/api/documents`, `/api/upload`, `/api/ask`) and a single-page UI.

**Verified:** built the Worker bundle, served it with `wrangler dev`, and drove the
real UI in a browser — domain selector, corpus list, question submission, loading
skeleton, answer panel with evidence status and citations, empty state. Confirmed a
live `/api/ask` call end to end against the production build.

### 2. Cloudflare configuration — **Done**

`wrangler.toml` declares D1, R2, and Vectorize bindings, all `remote = true` so local
development runs against the same resources as production. `MISTRAL_API_KEY` is
deliberately **not** in `[vars]` — that ships in plaintext with the Worker.

**Verified:** `wrangler dev` reports all three bindings resolving in `remote` mode.

### 3. D1 schema and migrations — **Done**

`migrations/001_init_schema.sql`, seven tables: `corpora`, `documents`, `chunks`,
`questions`, `citations`, `evaluation_runs`, `evaluation_records`.

**Verified:** applied with `npm run db:migrate:remote`; all seven tables visible and
populated in the D1 Studio console.

Design note: domain-specific fields (asset ID, batch number, CAPA ID, validation
status) are **not** columns. They live in a `metadata` JSON column validated on write
by the active domain's Zod schema. Adding a domain therefore requires no migration.
The fields that *are* promoted to columns — `document_type`, `revision`,
`effective_date`, `doc_status`, `authority`, `superseded_by` — are promoted because
the shared retrieval layer reasons about them directly.

### 4. R2 integration — **Done**

Stores the original upload and the normalized extraction (`parsed.json`) under
`corpora/<corpus>/documents/<doc>/`.

**Verified:** objects written during every ingestion run; the parsed artifact means
re-chunking never re-runs OCR.

### 5. Vectorize integration — **Done**

1024-d cosine index matching `mistral-embed`. Namespace per domain, which is the
isolation boundary; corpus scoping and metadata filters are applied in D1.

**Verified:** 106 vectors indexed. Namespace isolation confirmed directly — an
industrial query returns 49 matches in the `industrial` namespace and 57 in
`pharma`, with no bleed.

### 6. Mistral OCR, embeddings, and generation — **Done**

All three live. See [MODELS.md](MODELS.md) for which model runs where and why.

**Verified:** two PDFs in the sample corpus go through `mistral-ocr-latest` on every
ingest, extracting in ~4–5s each with heading hierarchy and table structure intact.
Embeddings and generation are exercised by every eval run.

### 7. Industrial and pharma domain packs — **Done**

Five files each: `config.ts`, `metadata-schema.ts`, `system-prompt.ts`,
`query-examples.ts`, `evals.json`. Registered in `src/domains/index.ts`.

**Verified:** adding the pharma pack required **zero changes** to `src/core`. The
contract is enforced by tests in `src/domains/__tests__/packs.test.ts`, which check
every pack supplies the required fields, rejects another domain's document types,
rejects unknown metadata keys, and instructs the model not to imply approval.

### 8. CLI ingestion and question answering — **Done**

`npm run ingest` · `npm run ask` · `npm run eval`.

**Verified:** the CLI reaches the same live D1/R2/Vectorize through wrangler's
`getPlatformProxy`, so a document ingested by CLI and one uploaded via the web app
are indexed identically. Both corpora were ingested this way.

### 9. Evaluation harness — **Done**

Seven cases per domain across seven dimensions. Latency and token usage recorded per
case; results written to `evaluation_runs` / `evaluation_records` in D1.

**Verified:** 14/14 passing. Every check is mechanical — no LLM-as-judge, because a
model grading another model shares the failure modes being tested for.

```
Industrial Operations  7/7    p50 39563 ms · 56453 tokens
Pharmaceutical Mfg     7/7    p50 39752 ms · 53433 tokens
```

### 10. Sample synthetic documents — **Done**

16 documents (14 Markdown, 2 PDF), 106 chunks, across two domains. Fictional sites,
assets, products, and batches. No confidential, proprietary, patient, or personally
identifiable information.

Three deliberate cases per corpus:

| Case | Industrial | Pharma |
|---|---|---|
| Conflicting revisions | SP-204 Rev 6 vs Rev 7 — spading vs double block and bleed | SOP-CL-004 Rev 3 vs Rev 4 — 72h vs 120h hold time |
| Unresolved corrective action | CA-2026-031 overdue, no outage window | CAPA-2026-019 overdue, nothing complete |
| Missing evidence | Internal inspection never performed; thrust bearing at zero stock | SOP cites "VP-CL-2024-09 Addendum 1" — no such document |

**Verified:** all three cases are detected. See [the eval suites](../src/domains).

### 11. README — **Done**

Architecture, local setup, environment variables, Cloudflare setup, deployment,
design decisions, known limitations, production roadmap.

---

## Unit tests

70 tests over the pure logic — the parts where correctness matters most and no
network call is needed.

| Suite | Tests | Covers |
|---|---|---|
| `citations/validate.test.ts` | 21 | Quote grounding, status enforcement, the invariant that SUPPORTED needs a verified citation |
| `domains/packs.test.ts` | 24 | Domain-pack contract, metadata strictness, eval-suite shape |
| `generation/parse.test.ts` | 10 | Structured-output parsing, graceful degradation on malformed responses |
| `chunking/chunker.test.ts` | 8 | Heading paths, page boundaries, oversized sections |
| `retrieval/conflicts.test.ts` | 7 | Revision-conflict detection, including what must *not* be flagged |

Anything needing D1, R2, Vectorize, or Mistral is covered by the evaluation harness
against the live stack — mocking those would test the mocks.

---

## Not claimed

Stated explicitly, because the credibility of everything above depends on it.

- **Browser file upload has not been clicked through.** The `/api/upload` route was
  exercised directly and the ingestion pipeline is covered by the CLI, but a file has
  not been dragged into the actual UI.
- **The expandable "retrieved evidence" section has not been visually confirmed.** It
  renders in the answer panel; individual rows were never expanded in a browser.
- **OCR has not been benchmarked at scale.** Two clean, generated PDFs extract well.
  Nothing has been tested against scanned, rotated, skewed, or handwritten documents,
  which is where OCR usually degrades.
- **Latency is not production-grade.** p50 ~39s, dominated by generation. No
  streaming, so the UI shows a skeleton for the full duration.
- **No hybrid retrieval and no reranker.** Dense retrieval only. Exact-identifier
  lookups lean on the identifier appearing in surrounding text.
- **Single corpus per domain in the UI.** The schema and pipeline support many; the
  UI uses the conventional `<domain>-demo` id.

---

## Out of scope by instruction

Not built, but the extension points exist:

Authentication · multi-tenancy · workflow dashboards · notifications · autonomous
agents · scheduled monitoring · collaboration features · fine-tuning · DPO ·
enterprise integrations.

Corpus is already the isolation boundary, so multi-tenancy is a scoping change rather
than a redesign. Each of the others sits above the current pipeline rather than
requiring changes to it.

---

## Reproducing the verification

```bash
npm install
npx wrangler login
npm run db:migrate:remote
npm run ingest -- ./sample-documents/industrial
npm run ingest -- ./sample-documents/pharma
npm test          # 70/70
npm run eval      # 14/14
npm run preview   # live app on the Workers runtime
```
