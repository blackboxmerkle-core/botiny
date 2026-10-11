-- 0001_click_incentives: provider-funded show/click incentives (click-server).
-- Idempotent; applied by migrate() after schema.sql and recorded in schema_migrations.
-- 1) balance_ledger gains 'incentive_escrow': provider funds reserved when a result set carrying
--    incentives is issued, in the same transaction as requests/impressions. Never-negative invariant
--    still enforced by assertNonNegative(). Payouts/holdback live in incentive_ledger (separate).
ALTER TABLE balance_ledger DROP CONSTRAINT IF EXISTS balance_ledger_kind_check;
ALTER TABLE balance_ledger ADD CONSTRAINT balance_ledger_kind_check
  CHECK (kind IN ('topup_x402','admin_credit','impression_debit','incentive_escrow'));
-- 2) Append-only per-listing incentive offers, sequenced on market_seq so a request pins them.
CREATE TABLE IF NOT EXISTS incentive_offers (
  seq          BIGINT PRIMARY KEY DEFAULT nextval('market_seq'),
  listing_id   TEXT NOT NULL REFERENCES listings(listing_id),
  show_atomic  BIGINT NOT NULL CHECK (show_atomic >= 0),
  click_atomic BIGINT NOT NULL CHECK (click_atomic >= 0),
  set_by       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS incentive_offers_idx ON incentive_offers(listing_id, seq);
-- 3) Inputs needed to audit issued links per request (tokens are NOT part of response_hash).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS click_kid TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS click_config JSONB;
