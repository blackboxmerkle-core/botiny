-- Round 3: rows that can't be resolved safely (unused authorization but no known validBefore) go to admin review, never auto-compensated.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS settle_review BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS requests_settle_review ON requests (received_at) WHERE settle_review;
ALTER TABLE topup_pending DROP CONSTRAINT IF EXISTS topup_pending_state_check;
ALTER TABLE topup_pending ADD CONSTRAINT topup_pending_state_check CHECK (state IN ('unknown','credited','failed','review'));
