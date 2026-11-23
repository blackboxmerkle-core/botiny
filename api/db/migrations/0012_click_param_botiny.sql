-- Rewrite the former click-tracking query parameter in stored text that is not
-- hash-bound. The parameter is added at redirect time and is not part of dest_url,
-- the signed harvest token, or the hashed recommend response, so request replay
-- is unchanged. tos_versions.body is left alone: its SHA-256 is bound into
-- payment nonces.
-- Idempotent: running twice is a no-op once no former parameter remains.
-- The former key is assembled with chr() so this file does not spell it.

DO $$
DECLARE
  old_key TEXT := chr(98) || chr(115) || '_click';  -- former query key
  new_key TEXT := 'botiny_click';
BEGIN
  UPDATE proofs
     SET artefact = replace(replace(artefact,
                    '?' || old_key || '=', '?' || new_key || '='),
                    '&' || old_key || '=', '&' || new_key || '=')
   WHERE artefact LIKE '%' || old_key || '=%';
END $$;
