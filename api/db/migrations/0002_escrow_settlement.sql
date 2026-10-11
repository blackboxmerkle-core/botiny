-- 0002_escrow_settlement: escrow reversal (refund) rows + idempotency key.
-- 'incentive_escrow_reversal' (positive delta) returns unclaimed/expired or clawed-back incentive escrow to the
-- provider. escrow_ref = '<token>:<show|click>' is UNIQUE so settlement is idempotent.
ALTER TABLE balance_ledger DROP CONSTRAINT IF EXISTS balance_ledger_kind_check;
ALTER TABLE balance_ledger ADD CONSTRAINT balance_ledger_kind_check
  CHECK (kind IN ('topup_x402','admin_credit','impression_debit','incentive_escrow','incentive_escrow_reversal'));
ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS escrow_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS balance_ledger_escrow_ref_uq ON balance_ledger(escrow_ref);
ALTER TABLE balance_ledger DROP CONSTRAINT IF EXISTS balance_ledger_reversal_shape;
ALTER TABLE balance_ledger ADD CONSTRAINT balance_ledger_reversal_shape
  CHECK (kind <> 'incentive_escrow_reversal' OR (delta_atomic > 0 AND escrow_ref IS NOT NULL));
