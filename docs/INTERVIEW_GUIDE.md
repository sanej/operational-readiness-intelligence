# Technical interview guide

## The opening

**One sentence:** ORI helps an operations reviewer assemble a defensible answer from fragmented
procedures, permits, findings, and corrective actions—then shows what is supported, missing, or
conflicting without pretending to approve the work.

**Business hook:** the expensive failure is not slow document search. It is a plausible answer
that misses an overdue action or follows the wrong procedure revision. ORI makes those failure
modes first-class outputs.

**Prototype claim:** this is a logically sound RAG pipeline and an instrumented production
hypothesis. It is not presented as a validated safety system.

## Suggested 60-minute flow

| Time | Topic | What to land |
|---:|---|---|
| 0–5 min | Customer problem and user | One reviewer, one high-consequence question, fragmented evidence |
| 5–13 min | Live demo | Readiness synthesis, exact citations, conflict, gaps, human handoff |
| 13–25 min | RAG architecture | OCR → structured chunks → embeddings → authority-aware retrieval → Mistral → validation |
| 25–37 min | ML/LLM choices | failure modes, model choice, chunking, dense retrieval limits, structured outputs |
| 37–45 min | Evaluation | gold cases, deterministic checks, what the harness can and cannot prove |
| 45–53 min | Production hypothesis | shadow-mode pilot, measurable gates, isolation, queues, audit, model/index versioning |
| 53–60 min | Discussion | invite a deeper dive; keep two minutes for a crisp close |

## Demo choreography

Use the industrial domain. The customer story is clearer than starting with infrastructure.

1. Point out the corpus: controlled procedures, inspection, corrective action, permit, manual,
   and environmental requirement. Call out the draft permit and the two active SP-204 revisions.
2. Ask **“Is Compressor C-101 ready for planned maintenance?”**
3. While the request runs, explain the four stages visible in the answer object: retrieve,
   generate, validate citations, reconcile status.
4. Read the status before the prose: `CONFLICTING_EVIDENCE` is a state of the evidence, not an
   equipment decision.
5. Show one exact quote from each side of the isolation conflict, the overdue corrective action,
   missing permit/isolation evidence, and “must be verified by a qualified person.”
6. Expand retrieved evidence once to show raw/adjusted scores and uncited chunks. This proves the
   UI does not hide what the model ignored.
7. If time permits, switch shape with one narrow question: **“Which inspection findings remain
   unresolved?”** General Q&A remains the default; readiness is only a specialization.

The hardened live reference run on 2026-08-01 completed in 24.9s: 0.7s retrieval, 24.1s
generation, 5,663 prompt + 1,402 completion tokens, 13 retrieved chunks, and 6/8 exact citations
verified across five documents. Present it as one observed run, not a latency benchmark.

## Architecture story

```text
Documents
  → Mistral OCR/direct parsing
  → heading/page-aware chunks with lifecycle metadata
  → mistral-embed + Vectorize corpus namespace
  → dense retrieval + D1 scope/filter + authority/open-action ranking
  → counterpart revision pass + structural conflict detection
  → Mistral Medium 3.5 custom structured output
  → exact citation provenance + deterministic status rules
  → reviewer-facing answer and audit record
```

Three design decisions deserve most of the airtime:

- **Authority is part of retrieval.** Current and superseded procedures are semantically similar;
  cosine similarity alone cannot tell which should govern.
- **The model proposes; code reconciles.** Quotes must come from retrieved chunks, `SUPPORTED`
  cannot survive without verified evidence, and a material conflict overrides a support claim.
- **Abstention is useful output.** Missing evidence is actionable only when the system names what
  the reviewer must obtain next.

## Be precise about the trust boundary

What the code enforces:

- cited chunk was actually retrieved;
- displayed quote is an exact source span after typography/whitespace normalization;
- `SUPPORTED` cannot be emitted with zero verified citations;
- material detected conflicts surface in the final status;
- malformed generation fails toward `INSUFFICIENT_EVIDENCE`.

What it does **not** yet enforce:

- every material sentence has a claim-level citation;
- a verified quote semantically entails the prose that refers to it;
- retrieval found every critical document;
- model confidence is calibrated;
- OCR is reliable on difficult scans;
- authentication, tenant authorization, or regulated-system validation.

Saying this clearly is stronger than overclaiming “hallucinations are solved.”

## Likely deep-dive questions

### Why RAG instead of fine-tuning?

The facts change with document revisions, and reviewers need page/section provenance. RAG keeps
knowledge external and updateable. Fine-tuning may later help style, intent routing, or domain
terminology, but it is a poor source of current controlled facts.

### Why Mistral Medium 3.5?

This question requires multi-document synthesis, contradiction handling, and strict structured
output. Medium 3.5 is the quality-first current choice. The production experiment is to route
narrow Q&A to Mistral Small 4 only after the gold suite shows no quality regression. OCR 4 and
`mistral-embed` have separate jobs; one model is not forced to do everything.

### Why not use model confidence?

Self-reported confidence is not calibrated. The UI shows counted evidence support—verified versus
claimed citations and distinct sources—while retaining model confidence only for audit.

### Why dense retrieval if identifiers matter?

It is sufficient for the bounded prototype and demonstrates Mistral embeddings. It is explicitly
not the production end state. Exact identifiers, dates, and negations motivate hybrid lexical +
dense retrieval followed by reranking and obligation-level recall evaluation.

### How do you detect conflicts?

Structural detection compares lifecycle metadata for competing active revisions before
generation. The model can add substantive conflicts, but only when it identifies retrieved
chunks. Equivalent structural and semantic conflict records are merged for the customer view.

### What broke during testing?

The original live readiness run used loose JSON mode. It retrieved correctly, then generated
4,096 completion tokens and ended mid-object after 52s. The system failed safely but the demo did
not. The fix was Mistral custom JSON Schema with bounded fields/items plus a current model; the
next run completed with schema-valid output in 24.9s. This is a good example of evaluating the
pipeline, not just the prompt.

### How do you scale safely?

Start with a shadow-mode pilot and explicit promotion gates. Enforce identity-derived corpus scope,
queue ingestion, version every extraction/chunk/embed/prompt/model artifact, add hybrid retrieval
and claim-level validation, and keep the existing human approval workflow authoritative. The full
plan is in [`PRODUCTION_HYPOTHESIS.md`](PRODUCTION_HYPOTHESIS.md).

## Close

ORI's differentiation is not that it can chat with documents. It is that it treats evidence
currency, conflicts, missing records, and verification as product behavior. The prototype proves
the pipeline end to end; the next step is a scoped pilot that earns trust with reviewer outcomes
and failure-mode metrics.
