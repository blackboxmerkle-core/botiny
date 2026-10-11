# botsource — bot service-discovery marketplace (monorepo)

Bots pay per query (x402, USDC on **Base Sepolia testnet only**) for a ranked, replayable list of services (x402 APIs, MCP
servers, dev tools). Advertisers prepay to be promoted; every paid request is logged with its response hash, impressions and
debits in one DB transaction and can be replayed byte-for-byte.

```
api/        TypeScript API (Express), Postgres+pgvector, x402 payments, dashboard (/dashboard), simulator bots, tests, db schema
crawler/    bot-service crawler: connectors, dedupe, 402 probes, scoring, Postgres job queue, catalogue publishing
admin/      notes for the crawler UI (lives in the api/ dashboard, Crawler tab, for now)
contracts/  Base smart contracts (placeholder, testnet only)
docs/       product design, research, crawler design, screenshots/
```

## Quickstart (api)
```
sudo service postgresql start            # Postgres 17 + pgvector; db botrec (user bot/bot), tests use botrec_test
cd api && npm install
npm run seed                             # seed catalogue (31 entries, source URL each)
npm test                                 # mock payments, isolated test DB
cd ../crawler && npm test                 # crawler tests (same test DB)
npm run start:mock                       # :8402, no chain calls
# real testnet mode: create api/.env from api/.env.example (PAYMENT_MODE=x402, PAY_TO_ADDRESS, DASHBOARD_PASSWORD, PUBLIC_BASE_URL)
npm run supervise                        # keeps server + ngrok up; rewrites PUBLIC_BASE_URL if the tunnel URL changes
npm run sim:start / npm run sim:stop     # simulator search bots + simulated advertisers (needs PAYER_PRIVATE_KEY in env)
```
Details: [api/README.md](api/README.md). Design: [docs/bot-rec-market-design.md](docs/bot-rec-market-design.md).

Secrets (`api/.env`, payer key, advertiser keys in `api/logs/`) are git-ignored and must never be committed. Testnet only.

## Payments: our own x402 facilitator (EVM testnets only)
- `api/src/facilitator.ts` verifies x402 `exact` EIP-3009 payloads itself: it recovers the EIP-712 signature against the token's name, version, chainId and verifyingContract, then checks payTo, the amount, the validAfter/validBefore window, the nonce (`payment_nonces` table and on-chain `authorizationState`) and the payer's USDC balance.
  Settlement submits `transferWithAuthorization` from the **relayer** wallet (`RELAYER_PRIVATE_KEY` in `api/.env`, never committed) and waits for the receipt.
  The order is unchanged: verify, then one DB transaction (request, hash, impressions, ToS proof, nonce), then settle, then the status update.
- `api/src/chains.ts`: Base, Ethereum, Arbitrum and OP Sepolia, Polygon Amoy, Avalanche Fuji, and Unichain and World Chain Sepolia. USDC addresses come from Circle's page, and each EIP-712 domain was verified on-chain.
  Linea Sepolia is disabled because its domain doesn't match. Mainnets are listed but hard-disabled.
  The 402 response has one `accepts` entry per chain whose relayer has gas. A chain without gas drops out.
- Temporary fallback: while the relayer is unfunded, Base Sepolia settles through x402.org (`FACILITATOR_FALLBACK=1`). Verification is still done locally. This is flagged as `settle_via` in the dashboard.
- Terms of Service: `GET /v1/terms/:version` and `/v1/terms/advertiser/:version` serve the DRAFT placeholder text. Every 402 carries `tos {version,url,sha256}`.
  Payers must send `X-TOS-ACCEPT` and `X-TOS-SALT`, and use the EIP-3009 nonce `keccak256(tosHash || keccak256(canonicalJSON({route,params})) || salt)`, so the on-chain authorization proves acceptance. The ToS is editable in the Admin tab, and each save creates a new version.
