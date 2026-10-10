# bot-rec-market — local MVP

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

## Dashboard (read-only, local, NO AUTH — do not expose beyond localhost without adding auth)
http://localhost:8402/dashboard/ — tabs: API usage (all /v1 calls incl. 402/409/5xx from `api_log`, 5s auto-refresh),
Transactions (off-chain payments; on-chain payee/payer USDC balances, USDC Transfer events to payee over the last
LOG_WINDOW_BLOCKS=3000 blocks in 200-block chunks — the public RPC's getLogs limit — and reconciliation of x402 'settled' rows
against tx receipts), Requests (detail + "Replay & verify"), Advertisers (impression spend), Catalogue.
JSON under /dashboard/api/{usage,payments,chain,requests,requests/:id,advertisers,catalogue}. Only public addresses are used
(PAYER_ADDRESS env, default 0x0b68…5402); PAYER_PRIVATE_KEY is never read by the server.
Tests use a separate database (botrec_test) and mock payments. Screenshots: `npx tsx scripts/screenshot.ts` -> docs/.

## Public exposure via ngrok (auth added)
- Public: GET /v1/health, POST /v1/recommend (x402 paywall), GET /v1/requests/:id and /replay (bot-facing audit).
- HTTP basic auth (DASHBOARD_USER=admin / DASHBOARD_PASSWORD in .env; fails closed if unset): /dashboard/**, POST /v1/listings, GET /v1/audit/providers/:id.
- PUBLIC_BASE_URL in .env sets the x402 `resource` URL (else derived from the Host header).
- Tunnel: `/home/box/bin/ngrok http 8402 --config /home/box/.config/ngrok/ngrok.yml,/tmp/ngrok-crl.yml` where the extra file sets
  `agent.crl_noverify: true` (the box couldn't reach ngrok's CRL endpoint; TLS is still verified, only revocation lookup is skipped).
  Free-tier URLs change on restart: update PUBLIC_BASE_URL and restart the server. Browsers see ngrok's interstitial once; API clients can send `ngrok-skip-browser-warning: 1`.
