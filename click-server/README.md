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

## Settlement, Postgres store, wallet binding (click-settlement)
- `src/pg-store.js` – Postgres store (same async interface as MemoryStore; injected `query`, no deps). The API scores clicks with it under `CLICK_LEDGER_LOCK`.
- Escrow lifecycle (API `src/clicks.ts`): issue → `incentive_escrow` (−) per provider; click/show accrue → held → vest after holdback (stays spent); unclaimed after deadline+grace, or clawed back → `incentive_escrow_reversal` (+) per line, `escrow_ref` UNIQUE (idempotent), recorded in `escrow_refunds`. Settlement holds MARKET_LOCK + CLICK_LEDGER_LOCK.
- `src/binding.js` – EIP-191 signed bot requests (`X-Bot-Wallet`, `X-Bot-Timestamp`, `X-Bot-Signature` over method/path/wallet/timestamp/body-sha256), ±5 min skew, single-use signatures. Legacy unsigned proofs are accepted only while `allowUnsignedBotRequests` is on and are stored `binding='header'`.

## Policy: no refunds of escrowed incentives (2026-10-12)
Escrowed incentives are never credited back to the advertiser. Lines that can no longer be earned, and lines whose
click is clawed back as fraudulent, return to the listing's incentive pool (`incentive_pool_ledger`) and are
re-distributed (drawn before new advertiser money) until the offer expires; whatever is left at expiry is platform
revenue (`expired_revenue`). Offers carry `budget_atomic` + `expires_at`; ranker `promo-v3` gives offers behind their
linear budget schedule a bounded pacing boost inside the promoted slots (only above the relevance threshold), with
`pacing_at_ms` pinned in the request so replay matches. Reports: `GET /v1/advertisers/me/incentives/report[?format=csv]`,
Admin → Incentives. Legacy `incentive_escrow_reversal` rows written before this change are kept (append-only).
