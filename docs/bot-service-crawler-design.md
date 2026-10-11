# Bot-service crawler: design

Code: [`crawler/`](../crawler). UI: the **Crawler** tab of the dashboard in `api/` (`/dashboard`, basic auth).
The crawler shares the API's Postgres database. It writes only to its own `crawl_*` tables, plus append-only rows in `listings`.

## 1. Sources (API-first connectors)

| source_id | Endpoint | Paging | Licence class | What we keep |
|---|---|---|---|---|
| `x402-bazaar` | `api.cdp.coinbase.com/platform/v2/x402/discovery/resources` (no key) | `limit`/`offset`, resumable | `public-metadata` | resource URL, service name, short description, tags, accepts (network/amount/asset/payTo), 30-day calls/payers |
| `agentic-market` | `api.agentic.market/v1/services` | `limit`/`offset` | **`ids-only`** | id, category, domain, endpoint URLs, prices. **Descriptions are never stored and never sent to an LLM.** Catalogue text for these items is built from a template of facts. |
| `mcp-registry` | `registry.modelcontextprotocol.io/v0.1/servers` | `cursor`, then **`updated_since`** (incremental, hourly) | `public-metadata` | name, title, description, remotes, packages, repo, status; latest version only |
| `smithery` | `api.smithery.ai/servers` | `page`/`pageSize` | `catalogue-facts` | qualified name, display name, summary clipped to 200 chars, useCount, verified/remote; link back |
| `virtuals-acp` | `acpx.virtuals.io/api/agents` | Strapi `pagination[page]` | `public-metadata` | agent, category/cluster, offerings and prices, job metrics, wallet |
| `npm` | `registry.npmjs.org/-/v1/search?text=keywords:{mcp,x402,a2a}` | `from`/`size` (≤2 pages per keyword) | `package-registry` | package name, description, links, monthly downloads, dependents |
| `glama` | n/a | n/a | `excluded` | **Skipped** (ToS). Row exists so the UI shows it as excluded. |

Each source has a per-run budget in `crawl_sources.config` (`page_size`, `max_pages`, `interval_min`), and its cursor is saved after every page.
A large catalogue is therefore covered over successive runs. When a cursor wraps, it restarts from offset 0, except for the MCP Registry, which switches to `updated_since=<run start>`.
If an endpoint returns non-JSON or a 4xx (moved, or now needs a key), the error is fatal for that run. The source is then marked **unhealthy** with `last_error`, and the other sources carry on.
A 429 or 5xx is retried with backoff. Some records are processed and some fail: the run is **partial** and the source **degraded**.

## 2. Normalised item

`crawl_items`: `type` (x402 | mcp | agent | package), `name`, `provider`, `domain`, `urls` {primary, endpoint, homepage, repo, remotes}, `summary` (+ `summary_source`), `category`, `tags`,
`pricing` {x402: {network, amount, asset, payTo, scheme, method}, probe: {...}, acp_offerings}, `signals` (keyed by source), `scores` {quality, usage, lead}, and `content_hash`.
Provenance lives in `crawl_item_sources`: one row per (source, source key), with `source_url`, `licence_class` and `fetched_at`.
A summary is only taken from licence classes that allow short text reuse (`public-metadata`, `catalogue-facts`, `package-registry`).

## 3. Dedupe

* **Hard keys** (`crawl_item_keys`, unique): `url:<normalised endpoint/remote URL>`, `mcp:<registry name>`, `payto:<address>@<domain>`, `npm:<package>`, plus source ids (`am:`, `smithery:`, `acp:`, `wallet:`).
  A record that matches any key joins that item. If its keys span several items, they are merged in one transaction (`status='merged'`, `merged_into`, and keys, sources and probes are re-pointed).
  payTo is scoped to a domain, so one seller's wallet doesn't collapse unrelated services. All Bazaar resources of one seller on one domain become one *service* item.
* **Near matches** go to `crawl_dedup_queue` for a human to review: same domain with name token Jaccard ≥ 0.6, or an identical normalised name on different domains. Domains with more than 200 items (github.com) are skipped.
  The UI's *Dedup review* tab offers **Merge** or **Distinct**. Near matches are never auto-merged.

## 4. Free 402 price probe

For x402 items, the probe sends **one unpaid request** (GET, or POST `{}` when the metadata says POST) with no payment header. It never uses a wallet.
It decodes the challenge from the v2 `PAYMENT-REQUIRED` header (base64 JSON), or from the v1 JSON body `{accepts:[...]}`, and records the network, amount, asset, payTo and number of options in `crawl_probes` and `pricing.probe`.
The probe checks robots.txt first, keeps to a 2-second per-host interval, re-probes an item at most once a day, and handles at most 60 items per post-process job.

## 5. Scores

* **quality (0–100):** summary 10, URL 5, category 5, corroborating sources 5 each (max 15), live 402 probe 15, x402 pricing 5, active registry entry 5, remote MCP 5, Smithery verified 5, recent activity (≤90 days) 10, ACP success rate ≥80% 5, and usage up to 20 (8 for packages).
* **usage (0–1):** the maximum of log-scaled Bazaar unique payers and calls, Smithery useCount, npm downloads and ACP jobs.
* **lead (0–100):** `min(100, 1.5·quality) × (1 − usage)`. It applies only to reachable (domain or homepage), non-package items with quality ≥ 40, so it favours good, live services with little traffic, which are the best candidates for paid promotion.
  Items with lead ≥ 45 enter `crawl_leads`, a pipeline with the stages new, qualified, contacted, won, lost and ignore. The pipeline is bookkeeping only: **nothing is sent automatically**.

## 6. Job queue and politeness

`crawl_jobs` is a Postgres queue. Workers claim jobs with `UPDATE … WHERE job_id = (SELECT … FOR UPDATE SKIP LOCKED)`. Failures back off exponentially (`60·2^attempts` seconds) up to `max_attempts`, after which a job is `failed`.
A job left running for more than 30 minutes is requeued. Jobs can be paused, resumed, cancelled or retried from the UI.
The kinds are `sync` (per source), `postprocess` (score, dedupe, probe, rescore, publish; enqueued after every sync), `probe`, `score`, `dedupe` and `publish`.
Every minute, the scheduler enqueues a sync for each enabled, unpaused source whose `interval_min` has passed.
`crawl_hosts.next_allowed_at` enforces per-host rate limits across workers: 1–1.5 s for APIs and 2 s for probes.
robots.txt is cached for 24 hours and checked before any page or probe fetch. Documented JSON APIs are fetched directly.
The User-Agent is `botsource-crawler/0.1 (+https://github.com/blackboxmerkle-core/botsource; …)`.

## 7. Feeding the recommend catalogue (replay-safe)

`publish` takes active items with quality ≥ `CRAWL_PUBLISH_MIN_QUALITY` (default 45) whose `content_hash` has changed since they were last published, up to 1500 per job.
Each one is written through the API's `insertListing` under the market advisory lock as a **new listing row**, with `provider_id = crawl:<domain>`, `source_url`, `licence_class`, `crawl_item_id` and `supersedes = <previous listing>`.
Listings are never updated in place. Every request pins its `catalogue_seq`, so requests made before a publish still replay to the identical hash. A test covers this.
The seed listings are kept. Crawled listings appear in the Catalogue tab with a *crawled* badge and their licence.

## 8. Operations

* The worker is `cd crawler && npm run worker`. `api/scripts/supervise.sh` keeps it running, and it logs to `crawler/logs/worker.log`.
* One-off commands: `npm run crawl -- sync <source> [maxPages]`, `npm run crawl -- postprocess`, `npm run crawl -- probe 100` and `npm run crawl -- publish`.
* Tests: `cd crawler && npm test` (robots, 402 decoding, hard and near dedupe, licence enforcement, scoring, the probe against a local 402 server, publish and replay, the queue, and sync health). `api/test/crawler-dashboard.test.ts` covers the UI API.
