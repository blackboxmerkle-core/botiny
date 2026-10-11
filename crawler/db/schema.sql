-- Bot-service crawler schema (shares the api Postgres database). Idempotent.
CREATE TABLE IF NOT EXISTS crawl_sources (
  source_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  licence_class TEXT NOT NULL,              -- public-metadata | ids-only | catalogue-facts | package-registry
  enabled       BOOLEAN NOT NULL DEFAULT true,
  paused        BOOLEAN NOT NULL DEFAULT false,
  health        TEXT NOT NULL DEFAULT 'unknown', -- healthy | degraded | unhealthy | unknown
  last_ok_at    TIMESTAMPTZ,
  last_error    TEXT,
  cursor        JSONB NOT NULL DEFAULT '{}',  -- resumable position (offset/cursor/updated_since)
  config        JSONB NOT NULL DEFAULT '{}',  -- page_size, max_pages per run, interval_min
  notes         TEXT
);
CREATE TABLE IF NOT EXISTS crawl_runs (
  run_id      SERIAL PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES crawl_sources(source_id),
  job_id      INT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | ok | partial | failed
  pages       INT NOT NULL DEFAULT 0,
  fetched     INT NOT NULL DEFAULT 0,
  new_items   INT NOT NULL DEFAULT 0,
  updated_items INT NOT NULL DEFAULT 0,
  errors      INT NOT NULL DEFAULT 0,
  error_sample TEXT
);
-- Postgres job queue: SELECT ... FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS crawl_jobs (
  job_id      SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,                    -- sync | probe | score | dedupe | publish
  source_id   TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed | paused | cancelled
  attempts    INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at   TIMESTAMPTZ,
  locked_by   TEXT,
  last_error  TEXT,
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crawl_jobs_ready_idx ON crawl_jobs(status, run_after);
CREATE TABLE IF NOT EXISTS crawl_items (
  item_id      TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                   -- x402 | mcp | package | agent | service
  name         TEXT NOT NULL,
  provider     TEXT,
  domain       TEXT,
  urls         JSONB NOT NULL DEFAULT '{}',     -- {primary, endpoint, homepage, docs, repo, remotes[]}
  summary      TEXT,                            -- only from sources whose licence allows text reuse
  summary_source TEXT,
  category     TEXT,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  pricing      JSONB NOT NULL DEFAULT '{}',     -- {x402:{network,amount,asset,payTo,scheme}, probe:{...}}
  signals      JSONB NOT NULL DEFAULT '{}',     -- per-source usage/quality facts
  scores       JSONB NOT NULL DEFAULT '{}',     -- {quality, lead}
  status       TEXT NOT NULL DEFAULT 'active',  -- active | merged
  merged_into  TEXT,
  content_hash TEXT,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_listing_id TEXT,
  published_hash TEXT
);
CREATE INDEX IF NOT EXISTS crawl_items_domain_idx ON crawl_items(domain);
CREATE TABLE IF NOT EXISTS crawl_item_keys (       -- hard dedupe keys: url:, mcp:, payto:, npm:, smithery:, acp:
  key      TEXT PRIMARY KEY,
  item_id  TEXT NOT NULL REFERENCES crawl_items(item_id)
);
CREATE TABLE IF NOT EXISTS crawl_item_sources (
  source_id     TEXT NOT NULL REFERENCES crawl_sources(source_id),
  source_key    TEXT NOT NULL,
  item_id       TEXT NOT NULL REFERENCES crawl_items(item_id),
  source_url    TEXT NOT NULL,
  licence_class TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  facts         JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (source_id, source_key)
);
CREATE INDEX IF NOT EXISTS crawl_item_sources_item_idx ON crawl_item_sources(item_id);
CREATE TABLE IF NOT EXISTS crawl_dedup_queue (
  id          SERIAL PRIMARY KEY,
  item_a      TEXT NOT NULL REFERENCES crawl_items(item_id),
  item_b      TEXT NOT NULL REFERENCES crawl_items(item_id),
  similarity_ppm INT NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | merged | distinct
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_a, item_b)
);
CREATE TABLE IF NOT EXISTS crawl_probes (
  id          SERIAL PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES crawl_items(item_id),
  url         TEXT NOT NULL,
  method      TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  http_status INT,
  ok_402      BOOLEAN NOT NULL DEFAULT false,
  x402        JSONB,
  error       TEXT,
  ms          INT
);
CREATE INDEX IF NOT EXISTS crawl_probes_item_idx ON crawl_probes(item_id, at);
CREATE TABLE IF NOT EXISTS crawl_hosts (             -- politeness + robots.txt cache
  host           TEXT PRIMARY KEY,
  next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  min_interval_ms INT NOT NULL DEFAULT 1000,
  robots_txt     TEXT,
  robots_fetched_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS crawl_leads (
  item_id    TEXT PRIMARY KEY REFERENCES crawl_items(item_id),
  stage      TEXT NOT NULL DEFAULT 'new',          -- new | qualified | contacted | won | lost | ignore
  notes      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- provenance columns on recommend listings (api) for crawled entries
ALTER TABLE listings ADD COLUMN IF NOT EXISTS licence_class TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS crawl_item_id TEXT;
