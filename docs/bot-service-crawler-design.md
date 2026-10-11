# Bot-service crawler — design (placeholder)

Status: to be written.

Open topics:
- Sources and permissions: x402 Bazaar discovery, Agentic Market API, MCP Registry API, llms.txt/agent cards, npm/PyPI metadata.
  Respect each source's terms; store facts plus our own short text plus links (see bot-rec-market-research.md).
- Data model: append-only listing versions with source_url and fetched_at; how a crawl publishes a new catalogue_seq.
- Dedupe and entity resolution, freshness and liveness probes, rate limits and politeness.
- Interface to api/ (bulk listing ingest) and to admin/ (monitoring).
