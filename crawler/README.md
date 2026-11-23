# crawler/ — Botiny bot-service crawler

TypeScript worker that discovers bot-consumable services and normalises them into `crawl_items`. It dedupes them, probes x402 prices for free (unpaid 402 responses only — it never pays), scores quality and advertiser-lead potential, and appends good items to the recommend catalogue.

It shares the API's Postgres database (it reads `../api/.env`) and reuses `api/src` for listing inserts.

The npm package name is `botiny-crawler`. The default User-Agent is `BotinyCrawler/0.1 (+https://github.com/blackboxmerkle-core/botiny; …)`.

## Sources

x402 Bazaar, Agentic Market (IDs only), the official MCP Registry, Smithery, Virtuals ACP, and npm, plus a `suggestion` job used by the human portal (URL submissions go through a DNS SSRF guard).

Outbound HTTP uses the shared SSRF-safe `safeFetch()`: http/https only, no userinfo, every DNS answer must be a public address, redirects are re-validated, with time and size caps.

## Run

```bash
npm test                            # isolated botiny_test, mock payments
npm run worker                      # queue worker + scheduler (also started by api/scripts/supervise.sh)
npm run crawl -- sync mcp-registry 3
npm run crawl -- postprocess        # score + dedupe + probe + publish
```

Design: [../docs/bot-service-crawler-design.md](../docs/bot-service-crawler-design.md). UI: dashboard → Crawler tab (source health, run history, jobs, items, dedup review, lead pipeline). Backend routes live in `api/src/crawlerAdmin.ts`.
