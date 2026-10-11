# crawler/ — bot-service crawler (to come)

Will discover and refresh bot-consumable services (x402 Bazaar / Agentic Market listings, the official MCP Registry,
llms.txt / agent cards, package registries) from permitted sources only, record a source URL and fetch time per fact,
and feed new catalogue versions to `api/` (append-only listings, so replays stay deterministic).
Design: [../docs/bot-service-crawler-design.md](../docs/bot-service-crawler-design.md).
