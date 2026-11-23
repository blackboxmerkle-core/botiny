# api/ — Botiny API, dashboard, portal, MCP

TypeScript Express service for the Botiny testnet marketplace. Bots pay (x402 test USDC, or prepaid credits) for a ranked list of services. Every paid request is logged with its response hash and impressions in one Postgres transaction and can be replayed.

The npm package name is `botiny-api`. Run all commands from this directory.

## Run

```bash
# Postgres 17 + pgvector; database botiny, role bot/bot. Tests use botiny_test.
npm install
npm run seed                 # 31 listings from db/seed-catalogue.json
PAYMENT_MODE=mock npm start  # :8402 (mock is also the default if .env is absent)
npm run start:mock           # force mock mode
npm test                     # never loads .env; always mock payments on botiny_test
npm run typecheck
npm run supervise            # API + ngrok; rewrites PUBLIC_BASE_URL if the tunnel URL changes
```

The process binds to loopback only (`API_HOST`, default `127.0.0.1,::1`). It is meant to be reached through a local tunnel (ngrok), not exposed on `0.0.0.0`.

Env (from `.env`, git-ignored; start from `.env.example` if present):

- `DATABASE_URL` — default `postgres://bot:bot@localhost:5432/botiny`
- `PORT` — default 8402
- `PAYMENT_MODE` — `mock` or `x402`
- `PAY_TO_ADDRESS` — required for x402
- `PRICE_ATOMIC` — default 1000 (0.001 USDC)
- `PUBLIC_BASE_URL` — x402 `resource` URL and short-link base
- `DASHBOARD_USER` / `DASHBOARD_PASSWORD` — basic auth; the dashboard fails closed if the password is unset
- `RELAYER_PRIVATE_KEY` / `RELAYER_ADDRESS` — settlement relayer; never the payer key
- `FACILITATOR_FALLBACK=1` — while the relayer has no test gas, Base Sepolia settlement can go through x402.org; verification stays local
- `PORTAL_APP_DIR` — portal static files (default is a sibling `botiny-brand/portal-app` directory, outside this repo)
- `CLICK_ATTEST_CONTRACT`, `ATTEST_PRIVATE_KEY` — optional; attestation stays off and writes nothing to the outbox when unset
- Click signing: `CLICK_SIGNING_KEY_JWK`, `CLICK_KID`, `CLICK_KEY_SECRET`. If no signing key is configured, links are still issued, all tracking-only, with a per-process ephemeral key.

Never commit `.env` or print private keys.

## Payments and ranking

- **Pay per query:** `POST /v1/recommend` with `X-PAYMENT`. Mock header: `mock:<unique-nonce>[:0xpayer]`. A payment header can be used once (409 on reuse).
- **Prepaid credits:** `POST /v1/credits/topup` (x402) issues a `bck_…` key on the first settled top-up (shown once; only sha256 is stored). `Authorization: Bearer bck_…` on recommend or MCP debits `query_price_atomic` in the same transaction as the request log. Default pack: 1 test USDC for 1,000 queries. Sending `X-PAYMENT` together with a key uses pay-per-query. See [../docs/credits-and-promo-v4.md](../docs/credits-and-promo-v4.md).
- **promo-v4** is the live ranker. Older requests replay with the ranker version stored on the row (v4, v3, v2 or v1).
- **Facilitator:** `src/facilitator.ts` verifies x402 `exact` EIP-3009 payloads locally, then the relayer submits `transferWithAuthorization`. ToS is bound into the nonce.
- **Chains:** `src/chains.ts` — Base, Ethereum, Arbitrum and OP Sepolia, Polygon Amoy, Avalanche Fuji, Unichain and World Chain Sepolia. Linea Sepolia is disabled. Mainnets are hard-disabled.

## Endpoints

### Search, audit, health

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health` | Mode, active chains, public pay-to and relayer addresses |
| GET | `/v1/chains` | All configured chains and which are active |
| GET | `/v1/terms`, `/v1/terms/:version`, `/v1/terms/advertiser/:version` | Versioned ToS |
| POST | `/v1/recommend` | Ranked results; 402 without payment or credits |
| GET | `/v1/requests/:id` | Audit record (restricted until settled, unless payer proof is presented) |
| GET | `/v1/requests/:id/replay` | Recomputes the hash; unsettled public replay does not re-rank |
| POST | `/v1/listings` | Create a listing (basic auth) |
| GET | `/v1/audit/providers/:id` | Impressions and spend (basic auth) |

### Credits, MCP, data feed

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/credits/pricing` | Pack price and ToS params |
| POST | `/v1/credits/topup` | Buy a pack; `?rotate_key=1` rotates the key |
| GET | `/v1/credits/me` | Balance and recent ledger |
| POST | `/mcp` | MCP streamable HTTP (stateless JSON-RPC). GET/DELETE → 405 |
| GET | `/v1/feed/tiers` | basic / pro prices and quotas |
| POST | `/v1/feed/subscribe?tier=basic|pro` | Buy a 30-day period; `bfk_…` key |
| GET | `/v1/feed/listings`, `/v1/feed/changes`, `/v1/feed/me` | Snapshot, change feed, account |

MCP tools: `botiny_search`, `botiny_listing`, `botiny_credit_balance`. Stdio bridge: `BOTINY_CREDIT_KEY=bck_… BOTINY_MCP_URL=https://<host>/mcp npx tsx src/mcp-stdio.ts`. Details: [../docs/mcp-and-data-feed.md](../docs/mcp-and-data-feed.md).

Scripts that exercise testnet top-ups (`scripts/credits-topup.ts`, `scripts/feed-subscribe.ts`) write keys under `~/.botiny/` (mode 0600) and never print them. They need `PAYER_PRIVATE_KEY` in the environment and cap spend.

### Advertisers and portal

Advertiser auth is a Bearer API key (`adv_…`) or a SIWE session. Cookie-authenticated mutating routes need the `X-Botiny-Client` CSRF header.

- `GET /v1/advertisers/me`, `POST /v1/advertisers/me/topup`
- `PUT /v1/advertisers/me/listings/:lid/bid`
- `PUT /v1/advertisers/me/listings/:lid/incentive` — upsert an incentive offer
- Campaigns: `GET|POST /v1/advertisers/me/campaigns`, listing stats, incentive report (JSON or CSV), attestations
- `DELETE /v1/advertisers/me/link` — unlink wallet from API key
- SIWE: `GET /v1/auth/siwe/nonce`, `POST /v1/auth/siwe/verify`, session, logout
- Suggestions, `GET /v1/bots/me`, per-bot stats and request logs (and CSV), ban appeals
- Click feed page: `GET /advertiser`

`dry_run` on campaign launch charges only the incremental commitment and never returns a negative balance.

### Clicks

`GET /c/:code`, `/c/:code/preview`, `/r/:token`, `/c/r/:token`, `POST /v1/proofs`. JWKS is at `GET /.well-known/botiny-keys`. Every recommend result gets `short_url` and `track_url` in a sibling `click_links` field, outside the hashed response.

## Determinism

- Listings are append-only; updates insert a new row with `supersedes`. The request pins `catalogue_seq` and `market_seq`.
- Embedding: `hbow-fnv1a-256-v1` (hashed unigrams + bigrams, L2-normalised, rounded to 6 decimal places), stored in pgvector `vector(256)`.
- Ranking uses an exact scan (no ANN). Scores are integer ppm. Tie-break is score desc, then `listing_id` asc (promo-v4 adds band, bid and pacing for sponsored slots only).
- Canonical JSON: sorted keys, no whitespace, integers only. `response_hash = sha256(canonical body)`.
- Replay refuses (409) if the build cannot call the logged embedding or ranker version.

## Transaction order

verify payment (or credit key) → `BEGIN REPEATABLE READ` → pin snapshot → rank → insert request, hash, impressions, advertiser debits, click links, credit debit → `COMMIT` → settle (x402 only) → update `payment_status`. On `settle_failed`, a follow-up transaction appends compensating rows and voids the request's incentive links. `db_txid` is stored as proof that request and impressions were written together.

## Dashboard

`http://localhost:8402/dashboard/` — HTTP basic auth. Tabs include API usage (with prepaid credits, data-feed and click-analytics cards), Bots / Try a search, Financials, Transactions, Requests (detail + replay), Advertisers, Catalogue, Crawler, and Admin (settings, wallets, ToS, bans, incentives, suggestions, audit).

JSON under `/dashboard/api/…`. The server never reads `PAYER_PRIVATE_KEY`. Financials treat credit top-ups and data-feed purchases as cash, not each credit-debited query.

“Try a search” is signed off in production-like configs (it would spend from the payer key). Simulator bots: `npm run sim:start` / `sim:stop` (needs `PAYER_PRIVATE_KEY`, testnet-only, daily budget caps).

## Schema

Migrations in `db/migrations/`:

| # | What |
|---|---|
| 0001–0002 | Click incentives and escrow settlement |
| 0003 | Incentive pool and pacing (no-refund policy) |
| 0004 | Track every result |
| 0005 | Portal (SIWE, suggestions, campaigns) |
| 0006 | Click attestation outbox |
| 0007–0009 | settle_failed compensation, settle_unknown, settle_review |
| 0010 | Prepaid search credits |
| 0011 | Data-feed subscriptions (idempotent `topup_pending.target`) |

The test runner checks the database name before migrating and will refuse to touch a non-`_test` database. The migration runner rejects duplicate number prefixes.

## Tests and helpers

`npm test` runs `test/*.test.ts` serially against `botiny_test`. Related docs and scripts: `scripts/replay-all.ts`, `scripts/credits-topup.ts`, `scripts/feed-subscribe.ts`, `scripts/screenshot.ts`.
