# Ingestion — what happens when a document arrives

Upload a file in the UI or run `npm run ingest`, and the same pipeline runs. Not a
similar one — literally the same `IngestionPipeline` class, reached through the same
Cloudflare bindings, writing to the same D1, R2, and Vectorize.

```
file bytes
   │
   ├─ 1. content hash (SHA-256, WebCrypto)          → duplicate check
   │
   ├─ 2. normalize                                   → per-page Markdown
   │      pdf / image / docx / pptx → Mistral OCR
   │      md / txt                  → decoded directly (+ YAML front matter)
   │      csv / json                → rendered to Markdown
   │
   ├─ 3. metadata: front matter ← caller override → validated by the domain pack
   │
   ├─ 4. write original + parsed.json to R2
   │
   ├─ 5. chunk on heading boundaries                 → provenance preserved
   │
   ├─ 6. embed (mistral-embed, batches of 64)
   │
   ├─ 7. upsert vectors to Vectorize (namespace = domain)
   │
   └─ 8. write chunks + document row to D1           → status: indexed
```

---

## The parts that used to be hand-rolled

Anyone who built a RAG pipeline in 2022–23 wrote most of this by hand. What changed
is not that the steps disappeared — it is where the decisions live.

| Hand-rolled approach | Here | Why |
|---|---|---|
| Split on a fixed character or token count | Split on Markdown headings; fall back to token windows only when one section is too large | A citation is only actionable if it names the section it came from |
| Chunk carries text and an index | Chunk carries page, section, heading path, revision, and lifecycle status | That is what a reviewer needs to verify a claim |
| Re-running the script duplicates the corpus | IDs are pure functions of `(corpus, content, index)` — re-ingest upserts in place | Idempotency by construction, not by a cleanup job |
| Local FAISS / Chroma index | Vectorize, namespaced per domain | Isolation is enforced by the store, not by filtering after the fact |
| Metadata as a loose dict | Zod schema per domain, `.strict()` | A typo like `assetID` fails at ingestion instead of becoming a filter that silently never matches |
| One embedding call per chunk | Batched 64 at a time, order preserved by re-sorting on the API's returned index | Fewer round trips, and the mapping back to chunks stays positional |
| Store the vector, discard the extraction | Parsed artifact written to R2 alongside the original | Re-chunking never re-runs OCR |

---

## Chunking, specifically

The rule set, in priority order:

1. **Split on Markdown headings.** Each section becomes a candidate chunk, carrying
   its full heading path (`SP-204 > 2. Isolation Requirements`).
2. **Keep the heading line inside the chunk.** It is often the only place the
   equipment tag or procedure number appears; dropping it strips that from the
   embedded text.
3. **Never merge across a page boundary.** That would make the chunk's page number a
   lie.
4. **Never merge across a top-level section.** Packing "§3 Gas Testing" with
   "§4 Permits" because both are short produces a chunk that cannot be cited
   precisely.
5. **Merge small adjacent subsections** up to the target size, and attribute the
   result to their deepest *common* heading. A chunk spanning §2.1–§2.3 is labelled
   "§2 Isolation Requirements", not "§2.1" — labelling it §2.1 would point a reviewer
   at the wrong place.
6. **Window oversized sections** with overlap, breaking on paragraph then sentence
   boundaries, so a procedure step is not severed mid-instruction.

The difference this makes is measurable. The first implementation — token windows
with the document title attached — produced **13 chunks for 7 documents**, nearly all
labelled with just the document name. The current one produces **49**, each
addressable to a real section.

```
#0    64t  SP-204 Energy Isolation and Lock-Out/Tag-Out
#1    32t  SP-204 … > 1. Purpose
#2   312t  SP-204 … > 2. Isolation Requirements for Compressor C-101
#3    87t  SP-204 … > 3. Gas Test Requirements
#4    90t  SP-204 … > 4. Permit Requirements
#5    56t  SP-204 … > 5. Verification and Clearance
```

Token counting is approximate — word-and-punctuation counting rather than a real BPE
tokenizer. A real tokenizer means native binaries or a large WASM blob in the Workers
bundle, and chunk sizing only needs to be consistent, not exact.

---

## Metadata

Three sources, merged in this order (later wins):

1. **YAML front matter** in the file itself (Markdown).
2. **A `<name>.meta.json` sidecar** next to the file (PDFs and images, which cannot
   carry front matter).
3. **Caller-supplied metadata** — the upload form, or `--metadata` on the CLI.

The merged result is validated by the active domain pack's Zod schema. Validation is
**strict**: an unrecognised key is an error, not an extension point.

Fields the shared pipeline reasons about are promoted to D1 columns —
`document_type`, `revision`, `effective_date`, `authority`, `doc_status`,
`superseded_by`. Everything else stays in a JSON column and is mirrored into
Vectorize metadata. That is why adding a domain requires no migration.

---

## Idempotency

Every identifier is derived, never random:

```
contentHash  = sha256(file bytes)
documentId   = "doc_" + sha256(corpusId + ":" + contentHash)[:16]
chunkId      = "chk_" + sha256(documentId + ":" + index)[:16]
vectorId     = "vec_" + sha256(chunkId)[:16]
```

Consequences:

- The same file in the same corpus is always the same document. Re-ingesting reports
  `already indexed` and skips the work.
- Re-ingesting after a **chunking change** upserts chunk rows and vectors in place
  rather than duplicating them.
- The web app and CLI cannot diverge, because neither generates IDs — both derive
  them from content.

WebCrypto, not `node:crypto`, so one implementation serves both the Worker runtime
and the Node CLI.

---

## Failure handling

The document row is written with `status: processing` **before** chunking begins, so
a failure leaves a row marked `failed` with its error message rather than leaving no
trace. The UI surfaces that on the document card.

A document that produces zero chunks is an error, not a silent success.

---

## What is not built

- **Uploads are synchronous.** A large batch will block the request. Cloudflare Queues
  is the fix, and is in the roadmap.
- **No incremental re-index.** Changing chunking configuration requires re-ingestion.
  IDs are deterministic so this upserts in place, but chunks orphaned by a previous
  scheme are not garbage-collected.
- **Tables are chunked as text.** A specification table can be split mid-row if the
  section overruns the window. Table-aware chunking is in the roadmap.
