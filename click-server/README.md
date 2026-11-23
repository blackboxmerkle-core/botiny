# click-server/ — Botiny click server (prototype, testnet only)

Click tokens, short-link redirects, click scoring and the incentive ledger for Botiny. The original prototype in this folder has been integrated into `api/` (recommend issues links, the API serves `/c` and `/r` routes, and settlement runs under the API's locks). This package remains the engine, tests, and a local adapter.

The npm package name is `botiny-click-server`. The JWKS path is `GET /.well-known/botiny-keys`.

Background specs (outside this repo): `Click_Server_Spec.md`, `Incentive_Math_Model_v3.md`, `Proof_of_Publishing.md`. Farcaster and sale/conversion incentives are out of scope.

## Layout

- `src/config.js` — every fee and threshold (fee presets `low` = $0.001, `standard` = $0.01; env `CS_FEE`, `CS_CFG_<name>`).
- `src/token.js` — Ed25519 signed per-result tokens (`hv_<payload>.<sig>`), WebCrypto only (Workers-compatible), JWKS export.
- `src/curation.js` — caps C1–C6 (line, cluster, slots, relevance, rank untouched, set cap).
- `src/classify.js` — unfurler / crawler / headless / datacentre / header checks; cookie-free end-user key (daily-salted hash of IP /24|/48 + UA + Accept-Language).
- `src/engine.js` — issue sets, resolve links, score clicks, clawbacks, proofs.
- `src/ledger.js` — append-only `incentive_ledger` (accrue_held → release / review_hold → review_cleared / clawback), 14-day holdback.
- `src/worker.js` — `fetch(request, env, ctx)` handler: `GET /:code`, `GET /:code/preview`, `GET /r/:token`, `POST /v1/proofs`, `GET /.well-known/botiny-keys`. 302 first; logging via `ctx.waitUntil`.
- `src/node-server.js` — local adapter on 127.0.0.1 with an ephemeral key and an in-memory store.
- `src/pg-store.js` — Postgres store used by the API under `CLICK_LEDGER_LOCK`.
- `src/binding.js` — EIP-191 signed bot requests (`X-Bot-Wallet`, `X-Bot-Timestamp`, `X-Bot-Signature`). Unsigned proofs are off by default.
- `db/schema.sql` — applied only to `clickserver_test` in this package; production tables are created by the API migrations.

`npm test` (node:test, no deps). `npm start` runs the local adapter.

## Integration with api/

`POST /v1/recommend` calls `engine.issueSet` after ranking. Incentive rows debit `incentive_escrow` in the same transaction as the request. The incentive ledger stays separate from per-impression bid debits.

### Every result is tracked (migration 0004)

Every ranked result, for every searching bot, gets a unique `short_url` and `track_url` (in the sibling `click_links` field, outside the hashed `response`) — not only incentivised rows.

- Rows inside the curated incentive set keep offers, caps, pool/pacing, escrow and the no-refund policy.
- Rows outside it, and every row when incentives are off, are **tracking-only**: amounts 0, no escrow, no ledger rows. Clicks redirect normally and are recorded as class `tracked` (never paid).
- Preview / bot / expired / too-fast / burst / self classification still runs so analytics can exclude them. Self-clicks on tracking-only links do not add fraud strikes.
- If there is no `CLICK_SIGNING_KEY_JWK`, links are signed by a per-process ephemeral key and are all tracking-only. The stored `harvest_tokens` row is the authority, so those links still resolve after a restart. The ephemeral key is not published in JWKS.
- Dashboard → API usage → “Result click analytics”.

### No refunds of escrowed incentives

Escrowed incentives are never credited back to the advertiser. Lines that can no longer be earned, and clawed-back clicks, return to the listing's `incentive_pool_ledger` and are redistributed first until the offer expires; leftover at expiry is platform revenue (`expired_revenue`). Offers carry `budget_atomic` and `expires_at`. promo-v3/v4 may apply a bounded pacing boost inside the sponsored slots. Reports: `GET /v1/advertisers/me/incentives/report`, Admin → Incentives.

Settlement (vest, unclaimed after deadline + grace, clawback) holds `MARKET_LOCK` + `CLICK_LEDGER_LOCK`. On `settle_failed`, the API voids the request's incentive links and appends compensating escrow rows.

### Attestation

Optional ClickAttestation feed on SKALE Europa testnet is implemented in `api/src/attest.ts` and `contracts/`. It is **off** unless the contract address and attester key are configured; when off, nothing is written to the outbox. The contract was not deployed in the mid-October testnet run because the network was unreachable. See [../contracts/README.md](../contracts/README.md).
