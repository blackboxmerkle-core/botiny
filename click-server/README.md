# click-server (prototype, testnet only)

Click server + incentive ledger for Bot Source. Specs: `Click_Server_Spec.md`, `Incentive_Math_Model_v3.md`, `Proof_of_Publishing.md` (Farcaster and sale/conversion incentives out of scope).

- `src/config.js` – every fee/threshold (fee presets `low`=$0.001, `standard`=$0.01; env `CS_FEE`, `CS_CFG_<name>`).
- `src/token.js` – Ed25519 signed per-result tokens (`hv_<payload>.<sig>`), WebCrypto only (Workers-compatible), JWKS export.
- `src/curation.js` – caps C1 (line item ≤0.25f), C2 (cluster ≤0.5f, pro rata), C3 (≤2 slots/cluster), C4 (relevance θ, ≥3 clusters else no incentives), C5 (rank untouched), C6 (set ≤4f).
- `src/classify.js` – unfurler/crawler/headless/datacentre/header checks; cookie-free end-user key (daily-salted hash of IP /24|/48 + UA + Accept-Language).
- `src/engine.js` – issue sets, resolve links, score clicks (dedupe, timing, self, burst, per-set cap, p95 bot-rate hold), chat show gating, clawbacks, proofs.
- `src/ledger.js` – append-only `incentive_ledger` (accrue_held → release / review_hold → review_cleared / clawback), 14-day holdback.
- `src/worker.js` – `fetch(request, env, ctx)` handler: `GET /:code`, `GET /:code/preview`, `GET /r/:token`, `POST /v1/proofs`, `GET /.well-known/botsource-keys`. 302 first, logging via `ctx.waitUntil` → queue.
- `src/node-server.js` – local adapter on 127.0.0.1 with ephemeral key and memory store.
- `db/schema.sql` – Postgres tables (applied only to `clickserver_test`).

Integration with `api/` (not done here): `/v1/recommend` calls `engine.issueSet` after ranking, debits `escrow_atomic` as a new `balance_ledger` kind `incentive_escrow`, and calls `noteBotApiCall` for self-click detection. The incentive ledger stays separate from per-impression debits.

`npm test` (node:test, no deps).
