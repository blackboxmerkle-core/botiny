-- Click server + incentive tables. Separate from api/db/schema.sql's balance_ledger (per-impression debits).
-- Apply only to a test DB here (clickserver_test). Integration with botrec is a later, reviewed migration.
CREATE SEQUENCE IF NOT EXISTS incentive_seq;

CREATE TABLE IF NOT EXISTS harvest_tokens (
  token TEXT PRIMARY KEY,                 -- 'hv_'+b64url(payload)+'.'+sig (Ed25519)
  kid TEXT NOT NULL,
  result_id TEXT NOT NULL UNIQUE, set_id TEXT NOT NULL, request_id TEXT, rank INT NOT NULL,
  listing_id TEXT NOT NULL, provider_id TEXT NOT NULL, cluster_id TEXT NOT NULL,
  bot_wallet TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('chat','web','x','onchain','bot')),
  dest_url TEXT NOT NULL, dest_url_hash TEXT NOT NULL,
  show_atomic BIGINT NOT NULL DEFAULT 0 CHECK (show_atomic >= 0),
  click_atomic BIGINT NOT NULL DEFAULT 0 CHECK (click_atomic >= 0),
  issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS harvest_tokens_set ON harvest_tokens(set_id);
CREATE INDEX IF NOT EXISTS harvest_tokens_bot ON harvest_tokens(bot_wallet, issued_at);

CREATE TABLE IF NOT EXISTS short_links (
  code TEXT PRIMARY KEY CHECK (code ~ '^[0-9A-Za-z]{10,12}$'),
  token TEXT NOT NULL REFERENCES harvest_tokens(token), dest_url TEXT NOT NULL, exp TIMESTAMPTZ NOT NULL);

CREATE TABLE IF NOT EXISTS publishers (
  publisher_id TEXT PRIMARY KEY, bot_wallet TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('domain','x','evm','bot')),   -- farcaster dropped
  handle TEXT NOT NULL, verified_at TIMESTAMPTZ, proof JSONB, UNIQUE (kind, handle));

CREATE TABLE IF NOT EXISTS clicks (
  click_id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES harvest_tokens(token),
  set_id TEXT NOT NULL, listing_id TEXT NOT NULL, bot_wallet TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL, end_user_key TEXT NOT NULL, ip_trunc TEXT, raw_ip INET, -- raw_ip nulled after 24h
  ua TEXT, asn INT, signed_agent TEXT,
  class TEXT NOT NULL CHECK (class IN ('paid_candidate','unpaid_duplicate','unpaid_expired','bot','preview','self')),
  reasons TEXT[] NOT NULL DEFAULT '{}', paid BOOLEAN NOT NULL DEFAULT false, clawed_back BOOLEAN NOT NULL DEFAULT false);
CREATE UNIQUE INDEX IF NOT EXISTS clicks_one_paid_per_token ON clicks(token) WHERE paid;
CREATE INDEX IF NOT EXISTS clicks_key_at ON clicks(end_user_key, at);
CREATE INDEX IF NOT EXISTS clicks_set ON clicks(set_id) WHERE paid;

CREATE TABLE IF NOT EXISTS proofs (
  proof_id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES harvest_tokens(token),
  channel TEXT NOT NULL CHECK (channel IN ('web','x','onchain','bot','chat')),
  artefact TEXT NOT NULL, publisher_id TEXT REFERENCES publishers(publisher_id), tier SMALLINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','rejected','released','clawed_back')),
  checks JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (token, channel));

CREATE TABLE IF NOT EXISTS incentive_ledger (       -- append-only
  seq BIGINT PRIMARY KEY DEFAULT nextval('incentive_seq'),
  entry_id TEXT NOT NULL,                           -- token || ':' || line
  line TEXT NOT NULL CHECK (line IN ('show','click')),
  token TEXT NOT NULL REFERENCES harvest_tokens(token), set_id TEXT NOT NULL,
  provider_id TEXT NOT NULL, cluster_id TEXT NOT NULL, bot_wallet TEXT NOT NULL,
  click_id TEXT REFERENCES clicks(click_id), proof_id TEXT REFERENCES proofs(proof_id),
  delta_atomic BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('accrue_held','review_hold','review_cleared','release','clawback','payout')),
  release_after TIMESTAMPTZ, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS incentive_one_accrual ON incentive_ledger(entry_id) WHERE kind IN ('accrue_held','review_hold');
CREATE INDEX IF NOT EXISTS incentive_bot ON incentive_ledger(bot_wallet, entry_id);
