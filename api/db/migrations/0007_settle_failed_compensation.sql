-- settle_failed compensation: a request whose x402 settlement failed is NOT billed. Its impression debits and click
-- escrow (committed in the recommend transaction) are reversed by append-only compensating rows written in a
-- follow-up transaction; the request/response log stays for audit and replay (hash/ranking untouched: the new rows
-- get a later market_seq than the request pinned, so every replay still sees exactly the state it ranked against).
ALTER TABLE balance_ledger DROP CONSTRAINT IF EXISTS balance_ledger_kind_check;
ALTER TABLE balance_ledger ADD CONSTRAINT balance_ledger_kind_check CHECK (kind IN
  ('topup_x402','admin_credit','impression_debit','incentive_escrow','incentive_escrow_reversal','impression_refund','incentive_escrow_void'));
ALTER TABLE balance_ledger DROP CONSTRAINT IF EXISTS balance_ledger_void_shape;
ALTER TABLE balance_ledger ADD CONSTRAINT balance_ledger_void_shape CHECK (kind NOT IN ('impression_refund','incentive_escrow_void') OR (delta_atomic > 0 AND request_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS balance_ledger_one_void ON balance_ledger(request_id, advertiser_id, kind) WHERE kind IN ('impression_refund','incentive_escrow_void');

ALTER TABLE incentive_pool_ledger DROP CONSTRAINT IF EXISTS incentive_pool_ledger_kind_check;
ALTER TABLE incentive_pool_ledger ADD CONSTRAINT incentive_pool_ledger_kind_check CHECK (kind IN
  ('funded','pool_draw','returned_unearned','returned_clawback','expired_revenue','void_funded','void_draw'));
-- void_funded: escrow that was funded for a voided request (un-counts it from the offer budget; the money goes back to the advertiser balance)
-- void_draw:   pool money drawn for a voided request (goes back into the listing pool)
CREATE UNIQUE INDEX IF NOT EXISTS incentive_pool_one_void ON incentive_pool_ledger(request_id, listing_id, kind) WHERE kind IN ('void_funded','void_draw');

ALTER TABLE requests ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'billed';
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_billing_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_billing_status_check CHECK (billing_status IN ('billed','voided','void_review'));
ALTER TABLE requests ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS void_detail JSONB;
ALTER TABLE harvest_tokens ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
