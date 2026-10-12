-- 0003_incentive_pool_pacing: NO refunds of escrowed click incentives (policy change).
-- Unearned / clawed-back lines go back to the listing's incentive POOL for re-distribution before the offer
-- expires; whatever is left in the pool at expiry becomes platform revenue. Existing reversal rows stay
-- (append-only) but no new ones are written. Offers gain a budget and an expiry for consumption pacing.
ALTER TABLE incentive_offers ADD COLUMN IF NOT EXISTS budget_atomic BIGINT CHECK (budget_atomic IS NULL OR budget_atomic > 0);
ALTER TABLE incentive_offers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
-- Per-listing pool, sequenced on market_seq so a request's pacing inputs are pinned by its market_seq.
--  funded             escrow taken from the advertiser balance at issuance (mirrors balance_ledger incentive_escrow)
--  pool_draw          issuance paid from the pool (no new advertiser money)
--  returned_unearned  line could no longer be earned -> back to pool      (one per entry_id)
--  returned_clawback  fraudulent click clawed back -> back to pool        (one per entry_id)
--  expired_revenue    pool balance at offer expiry -> platform revenue
CREATE TABLE IF NOT EXISTS incentive_pool_ledger (
  seq           BIGINT PRIMARY KEY DEFAULT nextval('market_seq'),
  listing_id    TEXT NOT NULL REFERENCES listings(listing_id),
  provider_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('funded','pool_draw','returned_unearned','returned_clawback','expired_revenue')),
  amount_atomic BIGINT NOT NULL CHECK (amount_atomic > 0),
  request_id    TEXT,
  entry_id      TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS incentive_pool_one_return ON incentive_pool_ledger(entry_id) WHERE kind IN ('returned_unearned','returned_clawback');
CREATE INDEX IF NOT EXISTS incentive_pool_listing ON incentive_pool_ledger(listing_id, seq);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS pacing JSONB;
