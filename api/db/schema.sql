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

-- Lightweight API access log (every /v1 call incl. 402/409/5xx). Not part of the paid-request transaction.
CREATE TABLE IF NOT EXISTS api_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  method      TEXT NOT NULL,
  route       TEXT NOT NULL,
  status      INT NOT NULL,
  ms          INT NOT NULL,
  request_id  TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS api_log_at_idx ON api_log(at);

-- per-bot attribution (X-Bot-Id header; untrusted label, not authentication)
ALTER TABLE requests ADD COLUMN IF NOT EXISTS bot_id TEXT;
ALTER TABLE api_log  ADD COLUMN IF NOT EXISTS bot_id TEXT;

-- ===== Advertiser marketplace (v2) =====
-- Versioned admin settings; each request pins settings_version. Append-only.
CREATE TABLE IF NOT EXISTS settings_versions (
  version     SERIAL PRIMARY KEY,
  settings    JSONB NOT NULL,
  changed_by  TEXT NOT NULL DEFAULT 'admin',
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One shared monotonic sequence for balance-ledger and bid/pause events, so a request can pin the whole
-- advertiser state with a single number (market_seq) and replay reproduces balances/bids exactly.
CREATE SEQUENCE IF NOT EXISTS market_seq;
CREATE TABLE IF NOT EXISTS advertisers (
  advertiser_id TEXT PRIMARY KEY,          -- equals listings.provider_id
  name          TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL UNIQUE,      -- sha256 of the advertiser API key
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Append-only balance ledger (USDC atomic). Balance = SUM(delta). Never negative (checked in-transaction).
CREATE TABLE IF NOT EXISTS balance_ledger (
  seq           BIGINT PRIMARY KEY DEFAULT nextval('market_seq'),
  advertiser_id TEXT NOT NULL REFERENCES advertisers(advertiser_id),
  delta_atomic  BIGINT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('topup_x402','admin_credit','impression_debit')),
  request_id    TEXT,                      -- for impression_debit
  listing_id    TEXT,
  settle_tx     TEXT,                      -- for topup_x402
  payment_ref   TEXT UNIQUE,               -- topup payment header hash (no reuse)
  payer         TEXT,
  note          TEXT,
  db_txid       BIGINT NOT NULL DEFAULT txid_current(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS balance_ledger_adv_idx ON balance_ledger(advertiser_id, seq);
-- Append-only bid / pause events per listing. Latest event with seq <= market_seq wins.
CREATE TABLE IF NOT EXISTS listing_bid_events (
  seq         BIGINT PRIMARY KEY DEFAULT nextval('market_seq'),
  listing_id  TEXT NOT NULL REFERENCES listings(listing_id),
  bid_atomic  BIGINT NOT NULL CHECK (bid_atomic >= 0),
  paused      BOOLEAN NOT NULL DEFAULT false,
  set_by      TEXT NOT NULL,               -- 'admin' | 'advertiser:<id>'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_bid_events_idx ON listing_bid_events(listing_id, seq);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS settings_version INT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS market_seq BIGINT;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS sponsored BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS fixed_atomic BIGINT NOT NULL DEFAULT 0;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS bid_atomic BIGINT NOT NULL DEFAULT 0;

-- facilitator error reason when settlement fails
ALTER TABLE requests ADD COLUMN IF NOT EXISTS settle_error TEXT;

-- provenance for crawled listings (crawler/)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS licence_class TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS crawl_item_id TEXT;

-- ---- Own facilitator (EIP-3009) + multi-chain + ToS binding ----
CREATE TABLE IF NOT EXISTS payment_nonces (        -- replay guard (also checked on-chain via authorizationState)
  chain_id   INT  NOT NULL,
  payer      TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  payment_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, payer, nonce)
);
CREATE TABLE IF NOT EXISTS tos_versions (          -- append-only; each admin edit = new version
  kind       TEXT NOT NULL,                        -- bot | advertiser
  version    INT  NOT NULL,
  body       TEXT NOT NULL,
  sha256     TEXT NOT NULL,                        -- 0x-prefixed sha256 of body (utf8)
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, version)
);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_chain_id INT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS settle_via TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS tos_version INT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS tos_hash TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS tos_proof JSONB;
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS payment_network TEXT;
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS payment_chain_id INT;
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS settle_via TEXT;
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS tos_version INT;
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS tos_hash TEXT;
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS tos_proof JSONB;

-- ---- Admin: versioned payTo wallet, audit log, bans ----
CREATE TABLE IF NOT EXISTS wallet_settings (      -- append-only; latest row = payTo in force
  version    SERIAL PRIMARY KEY,
  pay_to     TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id     BIGSERIAL PRIMARY KEY,
  at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS bans (
  ban_id     SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('bot','wallet','ip')),
  value      TEXT NOT NULL,                 -- bot id | checksummed address (stored lowercase) | IP or CIDR
  reason     TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  blocked_count INT NOT NULL DEFAULT 0,
  last_blocked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ban_events (          -- created / revoked / blocked attempts
  id      BIGSERIAL PRIMARY KEY,
  ban_id  INT NOT NULL REFERENCES bans(ban_id),
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  event   TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS pay_to TEXT;
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS pay_to TEXT;
