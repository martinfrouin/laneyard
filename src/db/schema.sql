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
  error_summary TEXT,
  -- The number this run was handed as LANEYARD_BUILD_NUMBER, null for a run
  -- that never started — and for every run that predates the counter, which is
  -- what `open.ts` fills the column with when it adds it.
  build_number  INTEGER,
  -- The app's own version, read off the working tree once the lane has finished
  -- — see `heuristics/app-version.ts`. Null when the project keeps it somewhere
  -- this cannot read, and for every run that predates the column.
  version       TEXT
);
CREATE INDEX IF NOT EXISTS run_by_project ON run (project_slug, id DESC);

-- One counter per project, holding the number the *next* run will be handed.
--
-- Keyed by slug rather than derived from the run table: run ids are global, so
-- a run of another project between two of yours would leave a hole, and the
-- number belongs to the app rather than to the server that built it. A project
-- with no row here has never run — `next` reads as 1 without one being written.
--
-- Editable, which is why it is a stored number and not a count of anything: a
-- project migrating from a counter its repository already kept starts where
-- that one stopped, and nothing else could express that.
CREATE TABLE IF NOT EXISTS build_number (
  project_slug TEXT    PRIMARY KEY,
  next         INTEGER NOT NULL,
  updated_at   TEXT    NOT NULL
);

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

-- `kind` is part of the key because more than one reader caches per project —
-- lanes and the actions each lane calls. Without it the second write overwrites
-- the first, and the next read returns a payload of the wrong shape rather than
-- missing the cache.
CREATE TABLE IF NOT EXISTS introspection_cache (
  project_slug TEXT NOT NULL,
  kind         TEXT NOT NULL,
  config_hash  TEXT NOT NULL,
  payload      TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (project_slug, kind)
);

-- Every secret belongs to one project. There was a second scope once — the
-- empty slug, read by every project — and `migrate-global-scope.ts` is what
-- became of the rows written under it.
-- `in_env_file` says this variable is also written into the file the build reads
-- from disk — see `runner/env-file.ts`. It is membership, not a second value: a
-- flagged secret still reaches the run as an environment variable like any
-- other. `open.ts` adds the column to a database written before it existed.
CREATE TABLE IF NOT EXISTS secret (
  project_slug TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  value_enc    TEXT    NOT NULL,
  masked       INTEGER NOT NULL DEFAULT 1,
  in_env_file  INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (project_slug, key)
);

-- A signing credential: a file plus the fields that make it usable. Separate
-- from `secret` because these are not key/value pairs — stored as loose rows,
-- nothing knew the parts belonged together, and deleting one left a half-dead
-- group no check could detect.
--
-- `fields_enc` is one encrypted JSON object rather than a column per field: the
-- three kinds do not share a shape, and a column per field would mean a
-- migration every time a kind gains one.
--
-- `var_names` is NOT encrypted. It holds variable names, never values, and the
-- interface has to display them.
CREATE TABLE IF NOT EXISTS credential (
  project_slug TEXT NOT NULL,
  kind         TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  file_enc     TEXT NOT NULL,
  fields_enc   TEXT NOT NULL,
  var_names    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_slug, kind)
);

-- Sessions outlive a restart, which is the whole reason they are here rather
-- than in a Map. What is stored is a SHA-256 of the token, never the token: the
-- cookie is a bearer credential, and a stolen `laneyard.db` must not hand
-- anybody a live session the way a table of raw tokens would.
--
-- `expires_at` is an ISO timestamp compared as text, which sorts correctly
-- because ISO-8601 does. A session with no end is not a convenience, it is a
-- credential nobody can lose track of.
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_by_name ON session (name);
