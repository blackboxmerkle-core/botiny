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
