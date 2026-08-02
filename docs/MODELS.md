# Mistral models — where each one runs, and why

Three Mistral models, each doing one job. OCR runs only for formats that need it,
embeddings run once per chunk at ingestion and once per question, and generation runs
exactly once per answer.

| Model | Job | Frequency | Why this choice |
|---|---|---|---|
| `mistral-ocr-4-0` | PDF/image/Office extraction as per-page Markdown | Once per document version | Current OCR service; preserves hierarchy and tables and can expose blocks/confidence for production review |
| `mistral-embed` | 1024-d chunk and query vectors | Per chunk at ingest; once per question | Stable text embedding endpoint matched by the Vectorize index |
| `mistral-medium-3-5` | Multi-document grounded answer as bounded structured output | Once per question | Quality-first current model for synthesis and structured outputs |

All three are configurable in `wrangler.toml` and read through `core/config.ts`. Exact
release ids are defaults for reproducibility; a release candidate should never silently
change because a `latest` alias moved. The API key is always passed explicitly rather
than read at module import time, which works in both Workers and the Node CLI.

Official references: [model selection](https://docs.mistral.ai/models/model-selection-guide),
[OCR](https://docs.mistral.ai/studio-api/document-processing/basic_ocr),
[embeddings](https://docs.mistral.ai/resources/cookbooks/mistral-embeddings-embeddings), and
[custom structured outputs](https://docs.mistral.ai/studio-api/conversations/structured-output/custom).

---

## `mistral-ocr-4-0` — extraction

**Runs for:** `pdf`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `docx`, `pptx`.

**Does not run for:** `md`, `txt`, `csv`, `json`; those are decoded directly or
rendered to Markdown without an API call.

The prototype sends bytes as a `data:` URI, avoiding a publicly reachable file URL.
OCR returns Markdown rather than flat text, so headings and tables feed the same
structure-aware chunker used for native Markdown. That is why citations can point to a
page and section rather than just a document.

The two clean sample PDFs were exercised successfully with the previous `latest` alias.
The current pinned OCR 4 default is API-compatible but has not been benchmarked against
the full scan-quality matrix. Production evaluation must include rotation, skew, faint
scans, handwriting, signatures, dense tables, multilingual documents, and low-confidence
page routing.

---

## `mistral-embed` — retrieval

The model produces **1024 dimensions**, which the Vectorize index must match:

```bash
npx wrangler vectorize create ori-vectors-dev --dimensions=1024 --metric=cosine
```

A dimension mismatch throws at ingestion rather than silently poisoning the index.
Embedding requests batch 64 chunks at a time, results are sorted by the API's returned
index, and each chunk is prefixed with its document title and heading path before
embedding:

```text
SP-204 Energy Isolation > 2. Isolation Requirements for Compressor C-101

1. Close and lock the suction isolation valve XV-C101-01.
```

An isolated procedure step embeds poorly without the system/procedure context held in
its headings. The prefix improves retrieval while the stored and cited content remains
the original source span.

Dense retrieval is the bounded prototype choice, not a claim that semantic search is
sufficient for operations. Production adds lexical retrieval for identifiers, dates,
negations, and exact references; fuses candidates; reranks; and measures obligation-level
recall.

---

## `mistral-medium-3-5` — grounded generation

Called once per question at `temperature: 0.1`. The response uses Mistral custom
structured outputs (`response_format.type = json_schema`) with bounds on answer length,
citations, conflicts, missing-evidence items, and human-verification items.

The schema requires:

```json
{
  "answer": "concise Markdown",
  "evidence_status": "SUPPORTED | PARTIALLY_SUPPORTED | CONFLICTING_EVIDENCE | INSUFFICIENT_EVIDENCE",
  "confidence": 0.0,
  "citations": [{ "chunk_id": "...", "quote": "exact source span", "relevance": 0.0 }],
  "missing_evidence": ["..."],
  "conflicts": [{ "description": "...", "chunk_ids": ["..."] }],
  "verification_required": ["..."]
}
```

### Why the bounded schema matters

The first live interview-path run used loose JSON mode with `mistral-large-latest`.
Retrieval succeeded, but generation reached the 4,096-token limit after 52 seconds and
ended mid-object. Parsing failed safely to `INSUFFICIENT_EVIDENCE`, which protected the
user but made the demo unreliable.

After moving to custom JSON Schema, bounding the response, and selecting Medium 3.5, the
same readiness query completed in **24.9s** with **1,402 completion tokens**. Six of eight
citation quotes passed exact validation across five documents; deterministic conflict
rules reconciled the model's `PARTIALLY_SUPPORTED` proposal to
`CONFLICTING_EVIDENCE`. This is one observed run, not a benchmark.

### What happens after generation

- Every cited chunk id must belong to the retrieved set.
- Every quote must be an exact span after whitespace and typography normalization.
- Invalid citations are dropped and shown as validation notes.
- `SUPPORTED` cannot survive with zero verified citations.
- A material structural or supported semantic conflict can override a support claim.
- Malformed/schema-invalid output degrades to `INSUFFICIENT_EVIDENCE`.

This validates citation **provenance**, not answer-wide entailment or claim coverage. A
production response should be composed of claim objects with citation ids, followed by
coverage and calibrated entailment/contradiction checks.

---

## What is not an LLM call

| Function | Mechanism |
|---|---|
| Citation provenance | Exact normalized string containment in a retrieved chunk |
| Status enforcement | Deterministic rules over surviving citations and conflicts |
| Revision conflict detection | Metadata comparison: same type/subject, two active revisions |
| Authority ranking | Arithmetic over lifecycle, dates, and open-action metadata |
| Evaluation checks | Mechanical inspection of status, retrieval, citations, conflicts, gaps, and approval wording |

There is deliberately no LLM-as-judge in the prototype harness. That keeps regression
checks deterministic, but it also means the harness does not score prose quality or
semantic entailment. Those require a human-labelled set and, if a learned judge is added,
calibration against that set.

---

## Production model routing

The first experiment is not “use the cheapest model.” It is an intent-segmented comparison:

- Mistral Small 4 for narrow general Q&A and extraction-shaped answers;
- Mistral Medium 3.5 for readiness and multi-document synthesis;
- the same citation/status enforcement after either model.

Promote routing only if critical-evidence recall, unsupported-claim rate, status F1,
conflict recall, latency, and cost remain inside the pilot gates in
[`PRODUCTION_HYPOTHESIS.md`](PRODUCTION_HYPOTHESIS.md).
