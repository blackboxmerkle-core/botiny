-- Human portal: SIWE sign-in, wallet <-> advertiser link, bot-owner wallet links, listing suggestions, ban appeals.
-- Additive only: no existing table, column, hash input or ranking input is touched.
CREATE TABLE IF NOT EXISTS siwe_nonces (
  nonce      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  used_by    TEXT);
CREATE INDEX IF NOT EXISTS siwe_nonces_exp ON siwe_nonces(expires_at);
CREATE TABLE IF NOT EXISTS portal_sessions (
  token_hash TEXT PRIMARY KEY,                    -- sha256 of the bearer/cookie token; the token itself is never stored
  address    TEXT NOT NULL,                       -- lowercase 0x address
  roles      TEXT[] NOT NULL,
  chain_id   INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS portal_sessions_addr ON portal_sessions(address);
CREATE TABLE IF NOT EXISTS advertiser_wallets (   -- 1 wallet <-> 1 advertiser (both unique)
  address       TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL UNIQUE REFERENCES advertisers(advertiser_id),
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bot_owner_wallets (    -- extra paying wallets proven (SIWE) by a signed-in owner
  wallet        TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS bot_owner_wallets_owner ON bot_owner_wallets(owner_address);
CREATE TABLE IF NOT EXISTS listing_suggestions (
  suggestion_id  TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  url_norm       TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('x402_api','mcp_server','agent','repo','other')),
  name           TEXT NOT NULL,
  description    TEXT,
  contact        TEXT,
  claim_wallet   TEXT,
  submitter_address TEXT,
  submitter_ip_hash TEXT,
  state          TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','queued','crawling','needs_review','indexed','rejected','duplicate')),
  detail         JSONB NOT NULL DEFAULT '{}',
  reason         TEXT,
  duplicate_of   TEXT,                            -- listing_id (or suggestion id prefixed sug_)
  listing_id     TEXT,
  crawl_item_id  TEXT,
  crawl_job_id   INT,
  claim          JSONB,                           -- {method, status, challenge, checked_at, error}
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS listing_suggestions_state ON listing_suggestions(state, created_at);
CREATE INDEX IF NOT EXISTS listing_suggestions_submitter ON listing_suggestions(submitter_address, created_at);
CREATE INDEX IF NOT EXISTS listing_suggestions_url ON listing_suggestions(url_norm);
CREATE TABLE IF NOT EXISTS bot_appeals (
  appeal_id  SERIAL PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  ban_id     INT REFERENCES bans(ban_id),
  address    TEXT NOT NULL,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','lifted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS bot_appeals_one_open ON bot_appeals(ban_id) WHERE status='open';
