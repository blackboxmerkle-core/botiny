-- Prepaid search credits for searcher bots (mirror of the advertiser prepaid balance) + promo-v4 settings.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'per_query';
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_payment_method_check;
ALTER TABLE requests ADD CONSTRAINT requests_payment_method_check CHECK (payment_method IN ('per_query','credits'));
CREATE INDEX IF NOT EXISTS requests_credits_payer ON requests(payer, received_at) WHERE payment_method='credits';
-- one API key per payer wallet (sha256 only; the key is shown once)
CREATE TABLE IF NOT EXISTS search_credit_accounts (
  wallet        TEXT PRIMARY KEY CHECK (wallet ~ '^0x[0-9a-f]{40}$' OR wallet ~ '^0xmock$'),
  api_key_hash  TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  key_rotated_at TIMESTAMPTZ
);
-- append-only ledger (USDC atomic). Balance = SUM(delta) >= 0 (checked in-transaction). No refunds.
CREATE TABLE IF NOT EXISTS search_credit_ledger (
  seq           BIGSERIAL PRIMARY KEY,
  wallet        TEXT NOT NULL REFERENCES search_credit_accounts(wallet),
  delta_atomic  BIGINT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('topup_x402','query_debit','admin_credit')),
  request_id    TEXT REFERENCES requests(request_id),
  payment_ref   TEXT UNIQUE,
  settle_tx     TEXT, payment_network TEXT, payment_chain_id INT, settle_via TEXT, pay_to TEXT,
  tos_version   INT, tos_hash TEXT, tos_proof JSONB,
  note          TEXT,
  db_txid       BIGINT NOT NULL DEFAULT txid_current(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind='query_debit') = (delta_atomic < 0)),
  CHECK (kind<>'query_debit' OR request_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS search_credit_ledger_wallet ON search_credit_ledger(wallet, seq);
CREATE UNIQUE INDEX IF NOT EXISTS search_credit_ledger_req ON search_credit_ledger(request_id) WHERE request_id IS NOT NULL;
-- pin the new defaults into a settings version so later default changes never alter replay of v4 requests
INSERT INTO settings_versions(settings, note, changed_by)
SELECT settings || '{"credit_pack_price_atomic":1000000,"credit_pack_credit_atomic":1000000,"sponsored_floor_ppm":250000,"sponsored_slots_max":1,"relevance_band_ppm":50000}'::jsonb,
       'migration 0010: search credits + promo-v4 defaults', 'migration'
  FROM (SELECT settings FROM settings_versions ORDER BY version DESC LIMIT 1) s
 WHERE NOT (s.settings ? 'sponsored_floor_ppm');
-- settle_unknown search-credit top-ups reuse topup_pending (reconciled on-chain by the same sweeper)
ALTER TABLE topup_pending ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'advertiser';
ALTER TABLE topup_pending ALTER COLUMN advertiser_id DROP NOT NULL;
ALTER TABLE topup_pending DROP CONSTRAINT IF EXISTS topup_pending_target_check;
ALTER TABLE topup_pending ADD CONSTRAINT topup_pending_target_check CHECK ((target='advertiser' AND advertiser_id IS NOT NULL) OR (target='search_credits' AND payer IS NOT NULL));
