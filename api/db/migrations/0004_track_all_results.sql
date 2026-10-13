-- 0004_track_all_results: every /v1/recommend result gets its own tracked link (short_url + track_url),
-- with or without an incentive offer. Zero-incentive links are 'tracked_only': amounts 0, no escrow, no ledger
-- rows; their clicks are recorded with class 'tracked' (never paid) for usage analytics.
ALTER TABLE harvest_tokens ADD COLUMN IF NOT EXISTS tracked_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clicks DROP CONSTRAINT IF EXISTS clicks_class_check;
ALTER TABLE clicks ADD CONSTRAINT clicks_class_check
  CHECK (class IN ('paid_candidate','unpaid_duplicate','unpaid_expired','bot','preview','self','tracked'));
CREATE INDEX IF NOT EXISTS clicks_token_at ON clicks(token, at);
CREATE INDEX IF NOT EXISTS harvest_tokens_request ON harvest_tokens(request_id);
