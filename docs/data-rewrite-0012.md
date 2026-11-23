# How historical testnet data stays replayable

23 November 2026, Europe/London. Migration `0012_click_param_botiny.sql`.

Public names are Botiny only: the JWKS path is `/.well-known/botiny-keys`, the crawler User-Agent is `BotinyCrawler`, and EIP-191 proofs are signed as `Botiny signed request v1`. The click-tracking query parameter appended on redirect is `botiny_click`.

## Request replay

Click links sit outside the hashed recommend `response` (sibling `click_links`). The destination stored on a harvest token (`dest_url`) is the listing address and does **not** include the click-tracking parameter; that parameter is added only when the short link redirects. Changing the parameter name therefore does not change response hashes, token signatures, or `dest_url_hash`. Logged requests still replay against the pinned catalogue, market and ranker versions.

## Migration 0012

`0012` rewrites the former click-tracking query parameter to `botiny_click` in stored text that is not hash-bound (currently `proofs.artefact`, which may hold a web URL). It is idempotent.

It does **not** rewrite:

- `harvest_tokens.dest_url`, `dest_url_hash`, or `short_links.dest_url` — these are bound into the signed harvest token.
- `tos_versions.body` — version 1 of the bot and advertiser ToS in a restored mid-October dump still uses the historical product name in its placeholder heading. That body was hashed into payment nonces (`X-TOS-ACCEPT`). Rewriting it would break those proofs. New databases already get the Botiny template. To update the live text, save a new ToS version in Admin; old requests keep their recorded hash and version.

The mid-October restore dump (`/workspace/backups/pre-feed-0011.sql`) contains no click-tracking parameters and no previous JWKS path. After restore, starting the API applies `0011` then `0012`.

## Stored proofs

Proof rows already saved as `verified` stay verified in the ledger; request replay does not re-check their EIP-191 signatures. New proof and earnings signatures must use `Botiny signed request v1`. A previously signed message cannot be re-signed by a migration because the payer's key is not on the server.
