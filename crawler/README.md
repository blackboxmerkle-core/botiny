# crawler/: bot-service crawler

This TypeScript worker discovers bot-consumable services (x402 Bazaar, Agentic Market (IDs only), the official MCP Registry, Smithery, Virtuals ACP and npm) and normalises them into `crawl_items`.
It dedupes them, probes x402 prices for free (unpaid 402 only), scores quality and advertiser-lead potential, and appends good items to the recommend catalogue.
It shares the API's Postgres database (it reads `../api/.env`) and reuses `api/src` for listing inserts. `node_modules` is a symlink to `../api/node_modules`.

    npm run worker                      # queue worker + scheduler (supervised by api/scripts/supervise.sh)
    npm run crawl -- sync mcp-registry 3
    npm run crawl -- postprocess        # score + dedupe + probe + publish
    npm test

Design: [../docs/bot-service-crawler-design.md](../docs/bot-service-crawler-design.md). UI: dashboard → Crawler tab.
