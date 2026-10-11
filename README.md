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
