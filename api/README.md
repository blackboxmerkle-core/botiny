# api/ — bot-rec-market API, dashboard, simulators (run all commands from this directory)

Service-discovery marketplace for bots. Providers list services; bots pay (x402, Base Sepolia USDC) for a ranked list.
Every paid request is logged with its response hash and per-listing impressions in ONE Postgres transaction, and can be replayed.

## Run
    sudo service postgresql start           # Postgres 17 + pgvector 0.8.0 installed on the box; db botrec, user bot/bot
    npm install
    npm run seed                            # 31 listings from db/seed-catalogue.json (source_url per entry)
    PAYMENT_MODE=mock npm start             # :8402 (default mode is mock)
    npm test                                # 6 tests (needs the DB)

Env: DATABASE_URL (default postgres://bot:bot@localhost:5432/botrec), PORT, PAYMENT_MODE=mock|x402,
PAY_TO_ADDRESS (required for x402), FACILITATOR_URL (default https://x402.org/facilitator), PRICE_ATOMIC (default 1000 = 0.001 USDC).
Network is hard-wired to base-sepolia (USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e); anything else throws at startup.

## Endpoints
- POST /v1/listings {provider_id,name,description,address,kind?,tags?,source_url?,cpi_micro_usdc?,supersedes?} -> {listing_id,catalogue_seq}
- POST /v1/recommend {query,k?} + header X-PAYMENT -> {request_id,response_hash,response}. No header -> 402 with x402 v1 `accepts`.
  Mock mode header: `mock:<unique-nonce>[:0xpayer]`. A payment header can be used once (409 on reuse).
- GET /v1/requests/:id/replay -> recomputes from the pinned snapshot, {logged_hash,replayed_hash,match}
- GET /v1/requests/:id (audit: request, payment, impressions), GET /v1/audit/providers/:id (impressions + spend per listing)

## Determinism contract
- Listings are append-only; `seq` is the catalogue version. Request pins `catalogue_seq = max(seq)` inside the transaction; updates = new row with `supersedes`.
- Embedding: `hbow-fnv1a-256-v1` (signed hashed unigrams+bigrams, L2-normalised, rounded 6dp), stored in pgvector `vector(256)`.
- Ranking `cosine-ppm-v1`: exact scan (no ANN), score = round(dot*1e6) integer, tie-break score desc then listing_id asc.
- Canonical JSON: sorted keys, no whitespace, integers only (floats rejected). response_hash = sha256(canonical response body).
- Replay refuses (409) if the build's embedding model / ranker version differs from the logged one. Keep old versions callable if you change them.

## Transaction order
verify payment (facilitator /verify or mock) -> BEGIN REPEATABLE READ -> pin snapshot -> rank -> INSERT request (+hashes, payer, payment ref) -> INSERT impressions -> COMMIT -> settle -> UPDATE payment_status.
`db_txid` (txid_current()) is stored on requests and impressions as proof they were written in the same transaction.

## Real testnet payments (not yet exercised)
Set PAYMENT_MODE=x402 and PAY_TO_ADDRESS=<your Base Sepolia receiving address>. The server needs no private key.
A paying test client needs a Base Sepolia wallet private key funded with test ETH and test USDC (faucet.circle.com), e.g. using `x402-fetch`/`x402-axios`.

## Configured testnet mode (current)
`.env` (git-ignored; copy in `.env.example`) sets PAYMENT_MODE=x402, PAY_TO_ADDRESS=0x0e66433540a91D9683E939c8Ac17BC084571D050,
X402_NETWORK=base-sepolia, FACILITATOR_URL=https://x402.org/facilitator. `npm start` loads it (`tsx --env-file=.env`);
`npm run start:mock` forces mock mode. `npm test` never loads .env, so tests always run in mock mode.
Verified 10 Oct 2026: x402.org facilitator `/supported` lists v1 exact/base-sepolia; a dummy-signed payload is rejected by
facilitator /verify with `invalid_exact_evm_signature` (no funds moved, nothing logged).

## Dashboard (read-only; basic auth — see "Public exposure" below)
http://localhost:8402/dashboard/ — tabs: API usage (all /v1 calls incl. 402/409/5xx from `api_log`, 5s auto-refresh),
Transactions (off-chain payments; on-chain payee/payer USDC balances, USDC Transfer events to payee over the last
LOG_WINDOW_BLOCKS=3000 blocks in 200-block chunks — the public RPC's getLogs limit — and reconciliation of x402 'settled' rows
against tx receipts), Requests (detail + "Replay & verify"), Advertisers (impression spend), Catalogue.
JSON under /dashboard/api/{usage,payments,chain,requests,requests/:id,advertisers,catalogue}. Only public addresses are used
(PAYER_ADDRESS env, default 0x0b68…5402); PAYER_PRIVATE_KEY is never read by the server.
Tests use a separate database (botrec_test) and mock payments. Screenshots: `npx tsx scripts/screenshot.ts` -> ../docs/screenshots/.

## Public exposure via ngrok (auth added)
- Public: GET /v1/health, POST /v1/recommend (x402 paywall), GET /v1/requests/:id and /replay (bot-facing audit).
- HTTP basic auth (DASHBOARD_USER=admin / DASHBOARD_PASSWORD in .env; fails closed if unset): /dashboard/**, POST /v1/listings, GET /v1/audit/providers/:id.
- PUBLIC_BASE_URL in .env sets the x402 `resource` URL (else derived from the Host header).
- Tunnel: `/home/box/bin/ngrok http 8402 --config /home/box/.config/ngrok/ngrok.yml,/tmp/ngrok-crl.yml` where the extra file sets
  `agent.crl_noverify: true` (the box couldn't reach ngrok's CRL endpoint; TLS is still verified, only revocation lookup is skipped).
  Free-tier URLs change on restart: update PUBLIC_BASE_URL and restart the server. Browsers see ngrok's interstitial once; API clients can send `ngrok-skip-browser-warning: 1`.

## Financials tab
/dashboard → Financials (basic auth). JSON: GET /dashboard/api/financials?from=YYYY-MM-DD&to=YYYY-MM-DD&type=bot_query_payment|advertiser_impression_charge&status=settled|verified|settle_failed|accrued&mode=x402|mock|offchain ;
CSV: /dashboard/api/financials.csv (same filters). Wallet balances (USDC + ETH) are live Base Sepolia reads. Ledger = bot query payments (off-chain status + on-chain receipt)
UNION advertiser impression charges with charge > 0 (ACCRUED ONLY — advertisers don't pay in yet). Totals: today (Europe/London day), 7d, all-time. Screenshot: `npx tsx scripts/screenshot-fin.ts` (reads .env creds).

## Simulator bots (live testnet traffic)
- `npm run sim:start` — background process running `research-bot` and `dev-bot` (X-Bot-Id header), each making a REAL x402 payment on Base Sepolia
  every 1–3 min (SIM_MIN_MS/SIM_MAX_MS) to PUBLIC_BASE_URL (re-read from .env each call). ~15% off-catalogue queries; 25% of steps replay-verify a past request instead.
- Safety: only pays exact/base-sepolia/testnet-USDC requirements ≤ 0.01 USDC; per-bot daily budget 0.5 USDC (SIM_DAILY_BUDGET_ATOMIC, tracked in logs/sim-state.json);
  global stop if payer USDC < 1. Key from PAYER_PRIVATE_KEY only, never logged.
- `npm run sim:stop` — graceful SIGTERM via logs/sim.pid. Logs: logs/sim-research-bot.log, logs/sim-dev-bot.log (JSON lines), logs/sim-main.log.
- `npm run supervise` — scripts/supervise.sh keeps server + ngrok alive (30s checks), rewrites PUBLIC_BASE_URL and restarts the server if the ngrok URL changes. Stop: `kill $(cat logs/supervise.pid)`.
- Dashboard: per-bot table + bot filter on API usage; bot filter, "Query revenue by bot" and bot column on Financials; bot shown in Requests.

## Advertiser marketplace (ranker `promo-v2`)
**Money flow (Base Sepolia TESTNET only).** Bots pay `query_price_atomic` per search (searcher fee). Advertisers prepay test USDC into an
append-only `balance_ledger` via x402 (`POST /v1/advertisers/me/topup?amount_atomic=1000..100000`, credited only after on-chain settlement),
or receive admin manual credits (testing only, no funds moved). Sponsored impressions debit `fixed_cpi_atomic + bid` from the balance
in the SAME DB transaction as the request, response hash and impressions; the transaction asserts no balance went negative.

**Ranking formula (deterministic, admin-configurable, versioned):**
1. Qualify: `score_ppm >= relevance_threshold_ppm` (cosine × 1e6), and listing not paused. Nothing below threshold is ever shown.
2. Promotion candidates: qualified listings whose provider has an advertiser account and a bid > 0;
   `promo_score = score_ppm + bid_weight_ppm_per_atomic × min(bid, max_bid_atomic)`; sort by promo_score desc, listing_id asc.
3. Walk candidates, granting up to `min(promoted_slots, k)` slots to those whose remaining balance (as of the pinned market_seq,
   minus earlier grants in this response) ≥ `fixed_cpi_atomic + bid`. Granted entries take the FIRST slots, carry
   `sponsored:true, label:"Sponsored", advertiser, bid_atomic, promo_score_ppm`, and are charged.
4. All other qualified listings are organic: by score desc, listing_id asc, **free** — including unfunded advertisers, which
   therefore rank lower than when promoted (they lose the top slots and the bid boost).
Defaults (settings v1): query price 1000 (0.001 USDC), fixed CPI 100, threshold 150000, 2 slots, bid weight 200 ppm/atomic, max bid 5000.

**Replay determinism.** Each request pins `catalogue_seq`, `market_seq` (shared sequence over balance_ledger + listing_bid_events),
`settings_version`, embedding model and ranker version. All writers and paid requests serialize on one advisory lock, so the
committed state at `market_seq` is exact; replay recomputes balances/bids as of that point. v1 requests still replay with ranker v1.

**APIs.** Admin (basic auth, dashboard Admin tab): `/dashboard/api/admin/{state,settings,advertisers,advertisers/:id/credit,listings/:lid}`.
Advertiser (Bearer API key, shown once at creation): `GET /v1/advertisers/me`, `PUT /v1/advertisers/me/listings/:lid/bid`, `POST /v1/advertisers/me/topup`.
Dashboard "Bots · Try a search" (`POST /dashboard/api/try`) makes a real x402 call server-side as research-bot/dev-bot (payer key stays server-side, ≤0.01 USDC, testnet).

**Simulated advertisers.** `adv:sim-scout` and `adv:sim-forge` (in sim-bots.ts) top up 0.005 USDC at a time from the payer wallet when
balance < 0.002, at most every 20 min, lifetime cap 0.05 USDC each; they random-walk bids (200–1200 atomic). Keys in logs/sim-advertisers.json (gitignored).

## Dashboard history & settlement errors
Requests, payments and bot-history lists are keyset-paginated (`?limit=1..500&before=<ISO received_at>&q=<id or query text>`;
`X-Next-Before` / `next_before` cursor, "Load older" buttons, search box). Only the Usage tab auto-refreshes, so expanded lists keep their state.
On-chain receipt statuses are cached permanently once final and fetched in parallel. Failed settlements store the facilitator's
reason in `requests.settle_error` (returned as `reason` in the 402). Rows from before 11 Oct 2026 have no recorded reason.
`npx tsx scripts/check-dashboard.ts` walks every tab via the public URL and reports JS/HTTP errors.
