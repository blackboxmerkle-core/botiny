# Security audit fixes, 2026-10-13

Scope: `/workspace/bot-rec-market` (api, crawler, click-server integration). x402 verification and EIP-3009 replay
protection are unchanged: the nonce is still reserved in the recommend transaction, the hashed response and ranking
are untouched, and every logged request still replays MATCH (524/524 after deploy).

| # | Finding | Fix | Files |
|---|---------|-----|-------|
| 1 | API on `*:8402`; client IP from the last `X-Forwarded-For` entry | Bound to loopback only (`API_HOST`, default `127.0.0.1,::1`, since ngrok dials `localhost`). `trust proxy` = `loopback`. `clientIp()` = `req.ip`, used for bans, rate limits and click IPs. XFF is honoured only when the TCP peer is loopback (ngrok's agent). | `api/src/server.ts`, `api/src/app.ts`, `api/src/bans.ts` |
| 2+3 | SSRF in the claim `.well-known` / repo fetch; crawler probe/robots/registry fetches (plus redirects) | One shared `safeFetch()`: http/https only; no userinfo; resolves DNS and requires **every** answer to be public; pins the socket to the vetted IP (custom `lookup`, SNI and cert still for the hostname); manual redirects re-validated per hop (limit 5, claim 3, probe 0); time and size caps. `assertPublicHost` now delegates to it. | `crawler/src/safe-fetch.ts`, `crawler/src/http.ts`, `crawler/src/probe.ts`, `crawler/src/suggest.ts`, `api/src/portal.ts` |
| 4 | Docker daemon on `0.0.0.0:2375` without TLS | **Not changed: reported.** The listener belongs to root in a namespace outside this box (`/pod-daemon` sandbox infra). No `dockerd`, socket, `daemon.json` or systemd unit is visible here, so its dependents can't be verified. Needs the box/infra owner. | none |
| 5 | Impression debits and click escrow committed before settlement, never reversed on `settle_failed` | Kept commit → settle (nonce reservation and replay pinning need it; settling first could charge a bot for a failed commit). On `settle_failed`, one follow-up transaction (MARKET_LOCK + CLICK_LEDGER_LOCK) appends compensating rows: `impression_refund` and `incentive_escrow_void` (balance), `void_funded` / `void_draw` (pool/budget). It also voids the request's links (incentives zeroed, `tracked_only`, `voided_at`) and sets `requests.billing_status='voided'`. Request, response and impressions stay for audit. The rows are idempotent (unique partial indexes) and carry a later `market_seq`, so replays are unchanged. A request with any accrued line goes to `void_review` instead. Backfilled: 72 historical settle_failed requests voided, 11 673 atomic impression debits refunded. | `api/src/compensate.ts`, `api/db/migrations/0007_settle_failed_compensation.sql`, `api/src/app.ts`, `api/src/pacing.ts`, `api/src/clicks.ts`, `api/scripts/void-unbilled.ts` |
| 6 | npm audit high (`ws`) | `overrides.ws = ^8.22.0` (api and crawler). The crawler now has its own `package.json` deps plus `package-lock.json` (was a symlink to api's `node_modules`). Remaining: 23 *moderate* findings, all in x402 → wagmi/walletconnect, which need an x402 major upgrade. | `api/package.json`, `api/package-lock.json`, `crawler/package.json`, `crawler/package-lock.json` |
| 7 | Error text leaks | `errorShape()` replaces every 5xx body with `{error: <code>, message: "internal error"[, request_id]}` and logs the detail server-side. Recommend 500 no longer returns `detail`. Recommend/topup 402 no longer return the settlement `reason` (`error: "settlement_failed"` + fixed message). Replay 409 is generic. The verify RPC error is generic. Claim-check errors only return our own diagnostics. | `api/src/app.ts`, `api/src/facilitator.ts`, `api/src/portal.ts` |
| 8 | Dashboard (must stay reachable via ngrok) | Basic auth kept (no cookie session to steal) and hardened. Fails closed if `DASHBOARD_PASSWORD` is < 16 chars or < 3 character classes (the current one passes). Per-IP lockout: 10 failures/15 min → 429 for 15 min, plus a global failure budget (200/h). CSRF: browser writes must be same-origin (`Sec-Fetch-Site` / `Origin`) **and** send `X-Botiny-Client`, the same rule as portal cookie sessions; the dashboard JS sends it on every call. `no-store`, `X-Frame-Options: DENY` and `frame-ancestors 'none'` are set. The real-payment **"Try a search" is disabled in the API process** unless `ADMIN_TRY_PAYER_SIGNING=1`; use `scripts/pay-recommend.ts` (separate local process) instead. Mock mode is unaffected. | `api/src/auth.ts`, `api/src/admin.ts`, `api/public/dashboard.html` |
| 9 | Secrets / relayer vs payer | `.env` stays 0600. The relayer check compares against **all configured payer addresses** (`PAYER_ADDRESS`, `PAYER_ADDRESSES`, the simulator payer's public address, and the `PAYER_PRIVATE_KEY` address if set), so it works with no payer key present. Used at relayer load and rotation. | `api/src/facilitator.ts`, `api/src/wallets.ts` |
| 10 | Public `/v1/requests/:id` and `/replay` | Still public. `payer` is redacted to `0xabcd…1234` plus `payer_sha256` (sha256 of the lowercase address, so bots can match their own wallet). `settle_error` and `db_txid` are dropped. Both are rate-limited. | `api/src/app.ts` |
| 11 | Rate limits | Per-IP and per-wallet fixed windows **before** the payment gate on `/v1/recommend` (600/min per IP, 300/min per wallet). Click routes 300/min per IP, replay 120/min, request 600/min, proofs 120/min per IP and 60/min per wallet. All are env-tunable (`RL_<NAME>_IP/_WALLET`). Direct loopback clients (local scripts, health checks) are exempt; ngrok traffic carries the real IP. | `api/src/app.ts` |

## 198.18.0.0/15
RFC 2544 benchmarking space. It is **blocked by default** in `safeFetch`. This box's DNS answers every hostname with
`198.18.0.1` (the sandbox egress fake-IP proxy), so the box sets `SAFE_FETCH_ALLOW_CIDRS=198.18.0.0/15` in
`api/.env` (read by the api and the crawler worker). **Never set it in production.** The env allow-list can never
re-enable loopback, link-local/metadata or `0.0.0.0/8`.

## Secret-store recommendation (item 9)
Keep secrets in `api/.env` (0600, git-ignored) on this box for now. There is no verified safer target here, so
nothing was moved. For production (botiny.si):
- load `RELAYER_PRIVATE_KEY`, `CLICK_SIGNING_KEY_JWK`, `CLICK_KEY_SECRET` and `DASHBOARD_PASSWORD` from a managed
  secret store (cloud KMS-backed secret manager, or systemd credentials / sops-encrypted file) injected at start;
- never give the API process a payer key; keep simulator and payer keys in the separate sim process only;
- prefer a KMS/HSM signer for the relayer, and rotate via the existing `ROTATE` flow.

## Tests
`api/test/security.test.ts` (7 tests): trust proxy and XFF (loopback vs a non-loopback peer), safe-fetch address
classes, v4-mapped, 198.18 policy, pinning, redirect re-check, hop and size caps, settle_failed compensation
(balances restored, pool un-counted, links voided, replay MATCH, idempotent), public redaction, rate limits
(per-IP, per-wallet before payment, click), admin lockout and CSRF, 5xx no-leak, relayer-vs-payer without a payer key.
The crawler probe test now asserts loopback is refused by default. Totals: api 85/85, click-server 45/45,
crawler 10/10, contracts 8/8.
