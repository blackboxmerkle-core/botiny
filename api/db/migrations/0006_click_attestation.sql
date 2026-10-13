-- 0006_click_attestation (0004/0005 are taken on master): public per-click attestation feed (SKALE Europa TESTNET, ClickAttestation contract).
-- Per-advertiser campaign salt: campaignHash = keccak256("botiny.campaign.v1|" || salt || "|" || advertiser_id || "|" || listing_id).
-- The salt is shown only to that advertiser, so competitors can't map campaign hashes to listings.
CREATE TABLE IF NOT EXISTS attest_salts (
  advertiser_id TEXT PRIMARY KEY REFERENCES advertisers(advertiser_id),
  salt          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now());
-- One row per attested click (hashes are what goes on chain; nothing here is a raw IP).
CREATE TABLE IF NOT EXISTS click_attestations (
  click_id      TEXT PRIMARY KEY,
  link_hash     TEXT NOT NULL,
  click_hash    TEXT NOT NULL UNIQUE,
  campaign_hash TEXT NOT NULL,
  advertiser_id TEXT NOT NULL,
  listing_id    TEXT NOT NULL,
  clicked_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS click_attestations_adv ON click_attestations(advertiser_id, clicked_at);
-- Outbox of on-chain events: kind 'click' (first status, Click event) then 'status' (StatusUpdate events).
-- state: pending -> sent (tx_hash known) -> confirmed (block_number + log_index) | failed (max attempts).
CREATE TABLE IF NOT EXISTS click_attestation_events (
  id            BIGSERIAL PRIMARY KEY,
  click_id      TEXT NOT NULL REFERENCES click_attestations(click_id),
  kind          TEXT NOT NULL CHECK (kind IN ('click','status')),
  status        SMALLINT NOT NULL CHECK (status BETWEEN 1 AND 5),
  reason        SMALLINT NOT NULL DEFAULT 0,
  at            TIMESTAMPTZ NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','confirmed','failed')),
  attempts      INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_hash       TEXT,
  block_number  BIGINT,
  log_index     INT,
  chain_id      BIGINT,
  contract      TEXT,
  last_error    TEXT,
  sent_at       TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ);
CREATE UNIQUE INDEX IF NOT EXISTS click_attestation_one_click_event ON click_attestation_events(click_id) WHERE kind = 'click';
CREATE INDEX IF NOT EXISTS click_attestation_events_state ON click_attestation_events(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS click_attestation_events_click ON click_attestation_events(click_id, id);
