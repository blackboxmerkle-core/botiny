CREATE EXTENSION IF NOT EXISTS vector;

-- Listings are APPEND-ONLY. An update is a new row with supersedes = old id.
-- A catalogue snapshot is simply "all rows with seq <= S that are not superseded by a row with seq <= S".
CREATE TABLE IF NOT EXISTS listings (
  seq              BIGSERIAL PRIMARY KEY,           -- monotonic catalogue version
  listing_id       TEXT NOT NULL UNIQUE,            -- stable id, e.g. lst_<hash>
  supersedes       TEXT REFERENCES listings(listing_id),
  provider_id      TEXT NOT NULL,                   -- the advertiser who pays per impression
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  address          TEXT NOT NULL,                   -- endpoint / URL
  kind             TEXT NOT NULL DEFAULT 'service', -- x402 | mcp | devtool | service
  tags             TEXT[] NOT NULL DEFAULT '{}',
  source_url       TEXT,                            -- provenance of seeded facts
  cpi_micro_usdc   BIGINT NOT NULL DEFAULT 0,       -- price per bot impression (6dp USDC atomic units)
  embedding_model  TEXT NOT NULL,
  embedding        vector(256) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  request_id        TEXT PRIMARY KEY,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  catalogue_seq     BIGINT NOT NULL,                -- pinned snapshot
  embedding_model   TEXT NOT NULL,
  ranker_version    TEXT NOT NULL,
  request_canonical TEXT NOT NULL,                  -- canonical JSON of the ranking inputs
  request_hash      TEXT NOT NULL,
  response_canonical TEXT NOT NULL,
  response_hash     TEXT NOT NULL,                  -- sha256 of response_canonical
  payer             TEXT,
  payment_mode      TEXT NOT NULL,                  -- mock | x402
  payment_network   TEXT NOT NULL,
  payment_amount_atomic BIGINT NOT NULL,
  payment_ref       TEXT NOT NULL UNIQUE,           -- sha256 of X-PAYMENT header (prevents payment reuse)
  payment_status    TEXT NOT NULL,                  -- verified | settled | settle_failed
  settle_tx         TEXT,
  db_txid           BIGINT NOT NULL DEFAULT txid_current()  -- id of the DB transaction that logged it
);

CREATE TABLE IF NOT EXISTS impressions (
  request_id      TEXT NOT NULL REFERENCES requests(request_id),
  rank            INT  NOT NULL,
  listing_id      TEXT NOT NULL REFERENCES listings(listing_id),
  provider_id     TEXT NOT NULL,
  charge_micro_usdc BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  db_txid         BIGINT NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (request_id, rank)
);
CREATE INDEX IF NOT EXISTS impressions_provider_idx ON impressions(provider_id, created_at);
