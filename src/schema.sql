PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS works (
  aweme_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  published_at TEXT,
  duration_sec REAL,
  cover_url TEXT,
  work_type TEXT,
  visibility TEXT,
  topic_id TEXT,
  works_dir TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collect_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','success','partial','needs_login','failed')),
  page_work_count INTEGER,
  api_work_count INTEGER,
  collected_count INTEGER NOT NULL DEFAULT 0,
  detail_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES collect_runs(id),
  aweme_id TEXT NOT NULL REFERENCES works(aweme_id),
  collected_at TEXT NOT NULL,
  plays REAL,
  finish_rate REAL,
  avg_play_duration_sec REAL,
  likes REAL,
  comments REAL,
  shares REAL,
  favorites REAL,
  follower_gain REAL,
  finish_5s_rate REAL,
  bounce_2s_rate REAL,
  cover_ctr REAL,
  profile_visits REAL,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  UNIQUE(run_id, aweme_id)
);
CREATE INDEX IF NOT EXISTS snapshots_work_time ON metric_snapshots(aweme_id, collected_at, id);
CREATE INDEX IF NOT EXISTS snapshots_run ON metric_snapshots(run_id);
PRAGMA user_version = 1;
