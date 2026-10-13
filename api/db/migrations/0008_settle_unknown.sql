-- settle_unknown: settlement attempt whose outcome is ambiguous (timeout / network / tx without receipt). A reconciler
-- reads authorizationState(from, nonce) on-chain and resolves it to settled (billing kept) or settle_failed (compensated).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_valid_before BIGINT;          -- EIP-3009 validBefore (unix s) of the authorization
ALTER TABLE requests ADD COLUMN IF NOT EXISTS settle_checks INT NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS settle_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS requests_settle_open ON requests(payment_status) WHERE payment_status IN ('settle_unknown','settle_failed');
-- advertiser top-ups whose settlement was ambiguous: credited (idempotently, payment_ref unique) only once proven on-chain
CREATE TABLE IF NOT EXISTS topup_pending (
  payment_ref   TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL REFERENCES advertisers(advertiser_id),
  amount_atomic BIGINT NOT NULL CHECK (amount_atomic > 0),
  chain_id      INT, payer TEXT, nonce TEXT, valid_before BIGINT, mode TEXT NOT NULL,
  settle_tx     TEXT, settle_via TEXT, credit_meta JSONB NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown','credited','failed')),
  checks        INT NOT NULL DEFAULT 0, last_error TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ);
