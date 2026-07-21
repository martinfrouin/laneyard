CREATE TABLE IF NOT EXISTS run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug  TEXT    NOT NULL,
  lane          TEXT    NOT NULL,
  platform      TEXT,
  params        TEXT    NOT NULL DEFAULT '{}',
  status        TEXT    NOT NULL,
  branch        TEXT,
  commit_sha    TEXT,
  trigger       TEXT    NOT NULL DEFAULT 'manual',
  interactive   INTEGER NOT NULL DEFAULT 0,
  queued_at     TEXT    NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  exit_code     INTEGER,
  error_summary TEXT
);
CREATE INDEX IF NOT EXISTS run_by_project ON run (project_slug, id DESC);

CREATE TABLE IF NOT EXISTS run_step (
  run_id      INTEGER NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  duration_ms INTEGER,
  status      TEXT    NOT NULL,
  log_offset  INTEGER,
  source      TEXT    NOT NULL,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE IF NOT EXISTS artifact (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   INTEGER NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  filename TEXT    NOT NULL,
  path     TEXT    NOT NULL,
  size     INTEGER NOT NULL,
  kind     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS introspection_cache (
  project_slug TEXT PRIMARY KEY,
  config_hash  TEXT NOT NULL,
  payload      TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);

-- A global secret is stored with an empty project_slug rather than NULL:
-- SQLite considers two NULLs distinct in a UNIQUE index, so NULL would let the
-- same global name be inserted twice.
CREATE TABLE IF NOT EXISTS secret (
  project_slug TEXT    NOT NULL DEFAULT '',
  key          TEXT    NOT NULL,
  value_enc    TEXT    NOT NULL,
  masked       INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (project_slug, key)
);
