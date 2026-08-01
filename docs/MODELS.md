# Mistral models — where each one runs, and why

Three Mistral models, each doing one job. Nothing is called speculatively: OCR runs
only for formats that need it, embeddings run once per chunk at ingestion and once
per question, and the large model runs exactly once per question.

| Model | Called from | Job | Frequency |
|---|---|---|---|
| `mistral-ocr-latest` | `core/ingestion/ocr.ts` | Extract PDFs, images, and Office files as per-page Markdown | Once per document, ever |
| `mistral-embed` | `core/embeddings/mistral.ts` | 1024-d vectors for chunks and for the query | Per chunk at ingest; once per question |
| `mistral-large-latest` | `core/generation/generate.ts` | Grounded answer as structured JSON | Once per question |

All three are configurable in `wrangler.toml` (`MISTRAL_OCR_MODEL`,
`MISTRAL_EMBED_MODEL`, `MISTRAL_CHAT_MODEL`) and read through `core/config.ts`. The
API key is always passed in explicitly, never read from module scope — reading
`process.env` at import time is `undefined` on Workers.

---

## `mistral-ocr-latest` — extraction

**Runs for:** `pdf`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `docx`, `pptx`

**Does not run for:** `md`, `txt`, `csv`, `json` — those are decoded directly or
rendered to Markdown without an API call.

The bytes are sent as a `data:` URI, which avoids needing a publicly reachable URL
for the file.

**Why it matters more than "text extraction":** Mistral OCR returns **Markdown**, not
flat text. Headings survive as `##`, tables survive as pipe tables. That structure is
what makes section-aware chunking possible downstream — without it, every chunk from
a PDF would be attributed to the document rather than to a section, and citations
would say "page 1" instead of "§2.2 Process Isolation".

**Observed:** the two sample PDFs extract in roughly 4–5 seconds each, with heading
hierarchy and table structure intact. The chunker builds correct heading paths from
that output with no special-casing for the OCR route.

**Not benchmarked:** scanned, rotated, skewed, or handwritten documents. The sample
PDFs are cleanly generated.

---

## `mistral-embed` — retrieval

**1024 dimensions**, which the Vectorize index must be created to match:

```bash
npx wrangler vectorize create ori-vectors-dev --dimensions=1024 --metric=cosine
```

A dimension mismatch throws at ingestion rather than silently poisoning the index.

**Called twice in the system's life:**

1. **At ingestion**, once per chunk, batched 64 at a time.
2. **At question time**, once, for the query.

**One detail worth knowing.** Each chunk is prefixed with its document title and
heading path before embedding:

```
SP-204 Energy Isolation > 2. Isolation Requirements for Compressor C-101

1. Close and lock the suction isolation valve XV-C101-01.
...
```

An isolated procedure step ("Verify the valve is closed") embeds poorly — it has no
signal about which system or which procedure it belongs to. The prefix restores that
context without changing what gets stored or cited.

**Retries:** 429 and 5xx are retried with exponential backoff; 4xx errors surface
immediately, because they will fail identically every time.

---

## `mistral-large-latest` — grounded generation

Called once per question with `response_format: { type: 'json_object' }` and
`temperature: 0.1`. This is an extraction task, not a creative one.

**Returns:**

```json
{
  "answer": "...",
  "evidence_status": "SUPPORTED | PARTIALLY_SUPPORTED | CONFLICTING_EVIDENCE | INSUFFICIENT_EVIDENCE",
  "confidence": 0.0,
  "citations": [{ "chunk_id": "...", "quote": "verbatim text", "relevance": 0.0 }],
  "missing_evidence": ["..."],
  "conflicts": [{ "description": "...", "chunk_ids": ["..."] }],
  "verification_required": ["..."]
}
```

**The model's status is a proposal, not the answer.** After generation, every claimed
citation is checked against the chunks actually retrieved — the chunk must be in the
retrieved set, and the quote must genuinely appear in it. Citations that fail are
dropped and the status is capped by what survives. Across 38 questions asked during
development and evaluation, **9 (24%) had their status corrected this way.**

**Prompt assembly** is two layers:

- A shared scaffold in `core/generation/generate.ts` — grounding rules, the four
  evidence statuses, and the constraint that the system never implies approval.
- The domain pack's own prompt — terminology, document types, and what a competent
  reviewer in that field looks for.

No industry vocabulary appears in `core/`.

**Failure handling:** a malformed or schema-violating response degrades to
`INSUFFICIENT_EVIDENCE` with no citations. The prose is salvaged if it is usable, but
it carries no unearned status. Failing toward "we don't know" is the safe direction.

**Cost shape:** roughly 3–4k prompt tokens and ~2k completion tokens per question.
This call is the ~39s p50 latency; retrieval is 1–2s.

---

## What is *not* an LLM call

Worth being explicit, because these are the parts that make the evidence status mean
something:

| Function | How it works |
|---|---|
| Citation validation | Pure string comparison, normalised for whitespace and quote characters |
| Status enforcement | Deterministic rules over the surviving citation count |
| Revision-conflict detection | Metadata comparison — same type, same subject, two active revisions |
| Authority ranking | Arithmetic over document lifecycle and effective dates |
| Evaluation checks | Mechanical inspection of the answer object, including approval-language regexes |

There is deliberately **no LLM-as-judge** in the evaluation harness. A model grading
another model's output shares the failure modes being tested for.

---

## Swapping models

Everything routes through `createConfig()` in `core/config.ts`. To try a different
generation model, change `MISTRAL_CHAT_MODEL` in `wrangler.toml` — no code change.

Changing the **embedding** model is not free: `EMBED_DIMENSIONS` must match the new
model, the Vectorize index must be recreated at that dimensionality, and the corpus
must be re-ingested. Chunk IDs are deterministic, so the re-ingest upserts in place.
