-- Bulk catalogue data feed: API-key tiers with monthly request quotas, bought via x402 (testnet). No refunds.
CREATE TABLE IF NOT EXISTS feed_accounts (
  wallet         TEXT PRIMARY KEY,
  api_key_hash   TEXT NOT NULL UNIQUE,              -- sha256 of bfk_... (shown once)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  key_rotated_at TIMESTAMPTZ
);
-- one row per purchased month; a purchase while a period is active queues the next one after it
CREATE TABLE IF NOT EXISTS feed_periods (
  period_id     BIGSERIAL PRIMARY KEY,
  wallet        TEXT NOT NULL REFERENCES feed_accounts(wallet),
  tier          TEXT NOT NULL CHECK (tier IN ('basic','pro')),
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  quota         INT NOT NULL CHECK (quota > 0),
  used          INT NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= quota),
  max_page      INT NOT NULL CHECK (max_page > 0),
  price_atomic  BIGINT NOT NULL CHECK (price_atomic >= 0),
  kind          TEXT NOT NULL DEFAULT 'purchase_x402' CHECK (kind IN ('purchase_x402','admin_grant')),
  payment_ref   TEXT UNIQUE,
  settle_tx     TEXT, payment_network TEXT, payment_chain_id INT, settle_via TEXT, pay_to TEXT,
  tos_version   INT, tos_hash TEXT, tos_proof JSONB,
  settings_version INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_periods_wallet ON feed_periods(wallet, starts_at);
CREATE TABLE IF NOT EXISTS feed_usage (
  usage_id    BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL REFERENCES feed_accounts(wallet),
  period_id   BIGINT REFERENCES feed_periods(period_id),
  endpoint    TEXT NOT NULL,                 -- listings | changes
  status      INT NOT NULL,                  -- 200 | 402 (quota exhausted) | 429
  cursor_in   TEXT, cursor_out TEXT,
  items       INT NOT NULL DEFAULT 0,
  catalogue_seq BIGINT,
  ip          TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_usage_wallet ON feed_usage(wallet, at);
-- repair: the live DB recorded an early draft of 0010 (applied by a supervisor restart mid-edit) without these columns; idempotent
ALTER TABLE topup_pending ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'advertiser';
ALTER TABLE topup_pending ALTER COLUMN advertiser_id DROP NOT NULL;
ALTER TABLE topup_pending DROP CONSTRAINT IF EXISTS topup_pending_target_check;
ALTER TABLE topup_pending ADD CONSTRAINT topup_pending_target_check CHECK ((target='advertiser' AND advertiser_id IS NOT NULL) OR (target IN ('search_credits','feed_basic','feed_pro') AND payer IS NOT NULL));
INSERT INTO settings_versions(settings, note, changed_by)
SELECT settings || '{"feed_basic_price_atomic":500000,"feed_basic_quota":2000,"feed_basic_max_page":200,"feed_pro_price_atomic":2000000,"feed_pro_quota":20000,"feed_pro_max_page":1000}'::jsonb,
       'migration 0011: data feed tier defaults', 'migration'
  FROM (SELECT settings FROM settings_versions ORDER BY version DESC LIMIT 1) s
 WHERE NOT (s.settings ? 'feed_basic_price_atomic');
