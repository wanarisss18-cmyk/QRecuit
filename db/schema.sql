-- Smart Recruitment & OCR Portal — SQLite schema

CREATE TABLE IF NOT EXISTS users_hr (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('staff', 'manager')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Searchable / legally-required fields are columns; the rest of the paper
-- "ใบสมัครงาน" (education, skills, health declarations, ...) lives in application_json.
CREATE TABLE IF NOT EXISTS candidates (
  id                     INTEGER PRIMARY KEY,
  application_no         TEXT NOT NULL UNIQUE,
  tracking_token         TEXT NOT NULL UNIQUE,
  national_id            TEXT,
  title_th               TEXT,
  first_name             TEXT,
  last_name              TEXT,
  first_name_en          TEXT,
  last_name_en           TEXT,
  birth_date             TEXT,             -- ISO yyyy-mm-dd (ค.ศ.)
  phone                  TEXT,
  email                  TEXT,
  line_id                TEXT,
  -- address as on house registration (needed by the background-check letter)
  addr_house_no          TEXT,
  addr_moo               TEXT,
  addr_soi               TEXT,
  addr_road              TEXT,
  addr_subdistrict       TEXT,
  addr_district          TEXT,
  addr_province          TEXT,
  addr_postal_code       TEXT,
  father_name            TEXT,
  mother_name            TEXT,
  position_applied       TEXT,
  application_json       TEXT,
  review_flags           TEXT,             -- JSON: OCR cross-document mismatches for HR to look at
  status                TEXT NOT NULL DEFAULT 'PENDING_CHECK'
                         CHECK (status IN ('PENDING_CHECK', 'IN_CHECK', 'PASSED', 'REJECTED')),
  is_locked              INTEGER NOT NULL DEFAULT 0,
  -- push to the main HR system, allowed only after PASSED
  main_sync_status       TEXT NOT NULL DEFAULT 'NOT_ALLOWED'
                         CHECK (main_sync_status IN ('NOT_ALLOWED', 'QUEUED', 'SENT', 'FAILED')),
  main_sync_ref          TEXT,
  main_sync_error        TEXT,
  main_synced_at         TEXT,
  retention_delete_after TEXT,
  purged_at              TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_candidates_status ON candidates(status);
-- One open application per national ID (rejected/purged ones may re-apply later)
CREATE UNIQUE INDEX IF NOT EXISTS ux_candidates_active_nid
  ON candidates(national_id) WHERE status <> 'REJECTED' AND purged_at IS NULL;

CREATE TABLE IF NOT EXISTS work_experiences (
  id             INTEGER PRIMARY KEY,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  company        TEXT NOT NULL,
  business_type  TEXT,
  position       TEXT,
  duties         TEXT,
  salary         INTEGER,
  start_date     TEXT,
  end_date       TEXT,
  reason_leaving TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY,
  candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL
                CHECK (doc_type IN ('ID_CARD', 'DRIVER_LICENSE', 'HOUSE_REG', 'PHOTO', 'EDUCATION',
                                    'SIGNATURE', 'OTHER')),
  storage_path  TEXT NOT NULL,           -- relative to storage/ (swap for an S3/Blob key in production)
  original_name TEXT,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  ocr_json      TEXT,                    -- raw AI OCR result, verified against this exact file
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_documents_candidate ON documents(candidate_id);

-- One row per e-signed document (certified copy, PDPA, background-check letter, contract, ...)
CREATE TABLE IF NOT EXISTS consents (
  id                    INTEGER PRIMARY KEY,
  candidate_id          INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  consent_type          TEXT NOT NULL,
  consent_version       TEXT NOT NULL,
  content_sha256        TEXT NOT NULL,   -- hash of the exact text the candidate agreed to
  signature_document_id INTEGER REFERENCES documents(id),
  signed_at             TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address            TEXT,
  user_agent            TEXT
);

CREATE TABLE IF NOT EXISTS check_batches (
  id              INTEGER PRIMARY KEY,
  batch_no        TEXT NOT NULL UNIQUE,
  exported_by     INTEGER NOT NULL REFERENCES users_hr(id),
  exported_at     TEXT NOT NULL DEFAULT (datetime('now')),
  candidate_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS background_checks (
  id           INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  batch_id     INTEGER REFERENCES check_batches(id),
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PASSED', 'FAILED')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  result_at    TEXT,
  case_detail  TEXT,                     -- manager-only
  recorded_by  INTEGER REFERENCES users_hr(id)
);
CREATE INDEX IF NOT EXISTS ix_checks_candidate ON background_checks(candidate_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER REFERENCES users_hr(id),
  action       TEXT NOT NULL,
  candidate_id INTEGER,
  detail       TEXT,
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_candidate ON audit_logs(candidate_id);
