-- Operational Readiness Intelligence (ORI) — D1 schema
--
-- One schema serves every domain pack. Domain-specific facts (asset id, batch
-- number, CAPA id, validation status, ...) are NOT columns: they live in the
-- `metadata` JSON column, validated on write by the active domain's Zod
-- metadata schema, and mirrored into Vectorize metadata for filtering.
--
-- Adding a domain therefore requires no migration. The columns that ARE
-- promoted out of JSON (document_type, revision, effective_date, status,
-- authority, superseded_by) are promoted because the shared retrieval layer
-- reasons about them directly: revision recency and authority ranking, and
-- conflict detection, are domain-agnostic behaviours.

-- ===========================================================================
-- Corpora — a named document set scoped to one domain pack
-- ===========================================================================

CREATE TABLE IF NOT EXISTS corpora (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,              -- 'industrial' | 'pharma' | future pack
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_corpora_domain ON corpora(domain);

-- ===========================================================================
-- Documents — original file in R2, extracted text as a parsed artifact in R2
-- ===========================================================================

CREATE TABLE IF NOT EXISTS documents (
  id                  TEXT PRIMARY KEY,
  corpus_id           TEXT NOT NULL,
  domain              TEXT NOT NULL,

  file_name           TEXT NOT NULL,
  original_file_name  TEXT NOT NULL,
  file_type           TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  file_size           INTEGER NOT NULL,

  -- R2 keys: the original upload, and the normalized extraction.
  r2_key              TEXT NOT NULL,
  parsed_r2_key       TEXT,

  -- sha256 of file bytes. Same content in same corpus => same document id.
  content_hash        TEXT NOT NULL,
  extraction_method   TEXT NOT NULL,        -- 'ocr' | 'direct' | 'structured'
  page_count          INTEGER,
  language            TEXT,

  -- Promoted metadata: the shared pipeline reasons about these directly.
  title               TEXT,
  document_type       TEXT,                 -- domain-defined vocabulary
  revision            TEXT,                 -- e.g. 'Rev 3', 'v2.1'
  effective_date      TEXT,                 -- ISO-8601
  authority           TEXT,                 -- issuing body / owner
  doc_status          TEXT,                 -- 'active' | 'superseded' | 'draft' | 'withdrawn'
  superseded_by       TEXT,                 -- document id, when known

  -- Everything else the domain pack defines, as validated JSON.
  metadata            TEXT NOT NULL DEFAULT '{}',

  status              TEXT NOT NULL DEFAULT 'pending',  -- ingestion state
  error_message       TEXT,
  chunk_count         INTEGER NOT NULL DEFAULT 0,

  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  FOREIGN KEY (corpus_id) REFERENCES corpora(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_documents_corpus     ON documents(corpus_id);
CREATE INDEX IF NOT EXISTS idx_documents_domain     ON documents(domain);
CREATE INDEX IF NOT EXISTS idx_documents_hash       ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_type       ON documents(domain, document_type);
CREATE INDEX IF NOT EXISTS idx_documents_status     ON documents(status);

-- ===========================================================================
-- Chunks — retrieval units, each carrying provenance back to a page/section
-- ===========================================================================

CREATE TABLE IF NOT EXISTS chunks (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,
  corpus_id     TEXT NOT NULL,
  domain        TEXT NOT NULL,

  content       TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  total_chunks  INTEGER NOT NULL,

  -- Provenance. A citation is only meaningful if it can be pointed at.
  page_number   INTEGER,
  section       TEXT,
  heading_path  TEXT,                       -- 'Isolation > Electrical > LOTO'

  token_count   INTEGER NOT NULL,
  vector_id     TEXT,

  -- Chunk-level metadata: document metadata plus anything section-scoped.
  metadata      TEXT NOT NULL DEFAULT '{}',

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (corpus_id)   REFERENCES corpora(id)   ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_corpus   ON chunks(corpus_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vector   ON chunks(vector_id);

-- ===========================================================================
-- Questions — every asked question and the answer produced for it
-- ===========================================================================

CREATE TABLE IF NOT EXISTS questions (
  id                TEXT PRIMARY KEY,
  corpus_id         TEXT NOT NULL,
  domain            TEXT NOT NULL,

  question          TEXT NOT NULL,
  answer            TEXT NOT NULL,

  -- How the question was classified; selects the answer's structure.
  -- GENERAL_QA | SYNTHESIS | CONFLICT_CHECK | READINESS_ASSESSMENT
  intent            TEXT,

  -- SUPPORTED | PARTIALLY_SUPPORTED | CONFLICTING_EVIDENCE | INSUFFICIENT_EVIDENCE
  evidence_status   TEXT NOT NULL,
  -- What the model claimed before citation validation constrained it. Kept so
  -- the gap between claimed and enforced status is auditable.
  claimed_status    TEXT,
  confidence        REAL NOT NULL DEFAULT 0.0,

  missing_evidence  TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  conflicts         TEXT NOT NULL DEFAULT '[]',   -- JSON array of conflict objects
  verification_required TEXT NOT NULL DEFAULT '[]', -- JSON array: what a human must check

  -- Full retrieved set, so the UI can show evidence the answer did not cite.
  retrieved_chunks  TEXT NOT NULL DEFAULT '[]',
  warnings          TEXT NOT NULL DEFAULT '[]',

  retrieval_ms      INTEGER,
  generation_ms     INTEGER,
  total_ms          INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  model             TEXT,

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  FOREIGN KEY (corpus_id) REFERENCES corpora(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_corpus ON questions(corpus_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(evidence_status);

-- ===========================================================================
-- Citations — only those that survived validation against retrieved chunks
-- ===========================================================================

CREATE TABLE IF NOT EXISTS citations (
  id              TEXT PRIMARY KEY,
  question_id     TEXT NOT NULL,
  chunk_id        TEXT NOT NULL,
  document_id     TEXT NOT NULL,

  cited_content   TEXT NOT NULL,
  document_title  TEXT,
  page_number     INTEGER,
  section         TEXT,
  revision        TEXT,
  relevance_score REAL NOT NULL DEFAULT 0.0,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  FOREIGN KEY (question_id) REFERENCES questions(id)  ON DELETE CASCADE,
  FOREIGN KEY (chunk_id)    REFERENCES chunks(id)     ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_citations_question ON citations(question_id);
CREATE INDEX IF NOT EXISTS idx_citations_chunk    ON citations(chunk_id);

-- ===========================================================================
-- Evaluation records — one row per eval case execution
-- ===========================================================================

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,
  corpus_id     TEXT NOT NULL,
  total_cases   INTEGER NOT NULL DEFAULT 0,
  passed_cases  INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS evaluation_records (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  case_id             TEXT NOT NULL,
  domain              TEXT NOT NULL,
  question_id         TEXT,

  question            TEXT NOT NULL,
  expected_status     TEXT,
  actual_status       TEXT,

  -- Per-dimension outcomes, JSON: {"retrieval": true, "citation": false, ...}
  checks              TEXT NOT NULL DEFAULT '{}',
  passed              INTEGER NOT NULL DEFAULT 0,
  failure_reasons     TEXT NOT NULL DEFAULT '[]',

  latency_ms          INTEGER,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,

  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  FOREIGN KEY (run_id) REFERENCES evaluation_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_records_run    ON evaluation_records(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_records_domain ON evaluation_records(domain);
