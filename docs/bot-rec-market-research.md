# Bot Product-Recommendation Market: Research (data, storage, distribution)

Prepared 10 Oct 2026 (Europe/London). Builds on `/workspace/crypto-bot-marketplaces.md`.
Conventions: every figure is cited inline to the page it came from (checked 9–10 Oct 2026, unless noted otherwise). **ESTIMATE** marks anything I calculated or assumed. "Not verified" means I couldn't load the page or confirm the figure.

---

## (a) Data acquisition

### Summary: what we can use commercially

| Source | Access | Commercial use for a paid rec API | Notes |
|---|---|---|---|
| npm registry | Public JSON per package + `_changes` feed | Metadata is generally fine to index (check npm ToS before redistributing at scale) | ~4.48M docs |
| PyPI | JSON API, Simple API, RSS, BigQuery | Yes. BigQuery data is Creative Commons; they ask for a polite UA | ~912k projects |
| GitHub | REST/GraphQL API, GH Archive | **Restricted.** Use is capped by rate limits and ToS on resale and scraping | Use for signals, not for republishing content |
| Libraries.io | Open data dumps / API | CC-BY-SA 4.0 (share-alike) | Cross-registry, 9.96M packages |
| deps.dev | API + BigQuery | Licence not verified | Fresh to within ~1h |
| Wikidata | SPARQL / dumps | CC0 | Software/product entities |
| Product Hunt API v2 | GraphQL | **No** without permission | Attribution also requested |
| G2 / Trustpilot | none | **No** scraping or extraction | Capterra not verified |
| Common Crawl | S3/HTTP dumps | Allowed, but the content keeps third-party rights; you indemnify CC | Huge; extraction only |
| Amazon Creators API | API (PA-API 5 retired) | Yes under Associates licence, with strict caching rules | Needs 10 sales/30 days |
| Awin / CJ feeds | Product feed APIs | Yes for affiliates, under each advertiser's terms | Disclosure required |
| x402 Bazaar / Agentic Market | Public discovery APIs | Public listings, no key required | The paid-API catalogue our buyers want |
| Official MCP Registry | Public REST API | Public metadata | The MCP-tool catalogue |
| Vendor self-submission | Our own form/API | Ours, with an explicit licence grant in our terms | Best long-term source |

### Developer tools and packages

- **npm.** On 10 Oct 2026 a live `GET https://replicate.npmjs.com/registry` returned `doc_count` **4,475,687**.
  - The legacy replication feeds were deprecated on 29 May 2025, and `include_docs` was removed from `_changes`. To track changes, call `_changes?since=<seq>`, then fetch each package document from `https://registry.npmjs.org/<pkg>`. Sources: GitHub changelog posts of 2025-02-26 and 2025-04-22 on npm replication API changes.
  - Download counts come from the npm downloads API, which is useful as a popularity signal.
- **PyPI.** The pypi.org home page showed **912,339 projects, 9,837,068 releases, 21,922,857 files, 1,125,358 users** (live, 10 Oct 2026).
  - APIs ([docs.pypi.org/api](https://docs.pypi.org/api/)):
    - JSON API at `/pypi/<project>/json`
    - Index API at `/simple/` (PEP 691 JSON)
    - RSS feeds for updates
    - XML-RPC, slated for deprecation
  - The docs say there is no edge rate limit but ask for a descriptive User-Agent with contact details.
  - Download stats are in the public BigQuery tables `bigquery-public-data.pypi.file_downloads` and `distribution_metadata`, published under a Creative Commons licence ([docs.pypi.org/api/bigquery](https://docs.pypi.org/api/bigquery/)).
- **GitHub.**
  - REST rate limits are 60 req/h unauthenticated, 5,000 req/h authenticated, and 15,000 req/h for Enterprise Cloud ([docs.github.com rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
  - The **Acceptable Use Policies §7** say information scraped from GitHub may be used only for researchers' open-access publications or for archiving, not for spamming or selling personal data. §6 bars reproducing, reselling or exploiting the Service without permission. API use falls under ToS §H, which notes GitHub "may offer subscription-based access… that would result in resale" ([docs.github.com/site-policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)).
  - **Takeaway:** use GitHub stars, release recency and issue activity as ranking signals. Store short facts, link back, and avoid bulk-republishing READMEs. If we rely on GitHub data commercially, ask GitHub first.
  - **GH Archive** (gharchive.org) publishes hourly public-event dumps from 2011 onward, which works for activity signals.
- **Libraries.io** covers **9.96M packages across 32 package managers**. Data is **CC-BY-SA 4.0** and code is AGPLv3 (libraries.io). Share-alike may apply to derived databases, so get legal review before we mix it into a proprietary index.
- **deps.dev** (Google Open Source Insights) offers an API plus a BigQuery dataset, usually within about an hour of fresh (deps.dev). Licence: not verified.
- **Hugging Face Hub.** The API is rate-limited per bucket (huggingface.co docs). Exact numbers: not verified.
- **Wikidata.** Structured data is **CC0** (wikidata.org), so it is safe for entity and product facts such as official website, developer and licence.

### Bot-native catalogues (the highest-value seed for an agent audience)

- **x402 Bazaar (CDP).**
  - `GET /discovery/resources` and search are public with no API key. Search returns at most **20 results**, ranked by relevance plus quality: calls, unique payers, and completeness of description and schema ([docs.cdp.coinbase.com/x402/buyer/discover-services](https://docs.cdp.coinbase.com/x402/buyer/discover-services)).
  - The Get-discovered page says **"more than 23,000 x402 resources"** ([docs.cdp.coinbase.com/x402/seller/get-discovered](https://docs.cdp.coinbase.com/x402/seller/get-discovered)). A secondary tracker (shaduf.ai) counted 24,515 resources across 1,800 payTo addresses on 2026-10-03.
  - We can read these listings and rank them. Our edge is the opinionated "best for X" answer that Bazaar's 20-result relevance search doesn't give.
- **Agentic Market.** **3,169 services** per the prior research. Public API at `GET https://agentic.market/v1/services` and `/v1/services/search?q=`, plus an llms.txt.
- **Official MCP Registry.**
  - Public API at `https://registry.modelcontextprotocol.io/v0.1/servers?search=` ([modelcontextprotocol.io/registry/about](https://modelcontextprotocol.io/registry/about)). The registry is "metadata only" and built for aggregators like us to consume, roughly hourly.
  - Entries include `remotes` (e.g. streamable-http URLs) and `_meta` status fields. I confirmed this by fetching a live entry.
  - Total entry count: not verified. A full paginated count didn't finish within about 7 minutes at 100 entries per page, so the registry is large.
- Smithery, Glama and PulseMCP are also catalogues, but check each one's terms before ingesting. Linking to them is safer than copying their editorial text.

### Consumer and SaaS product data

- **Product Hunt API v2** (GraphQL) "must not be used for commercial purposes" unless you contact hello@producthunt.com, and attribution is requested ([api.producthunt.com/v2/docs](https://api.producthunt.com/v2/docs)). **Ask for permission or a commercial licence before using it.**
- **G2.** ToS §9 bans automated access, scraping or extraction of content, including reviews, ratings and rankings, without written consent ([legal.g2.com](https://legal.g2.com/terms-of-use)). **Do not scrape.** Partnership or API licensing is the only route.
- **Trustpilot.** Terms ban text mining, data mining and scraping without permission, explicitly including AI training ([legal.trustpilot.com](https://legal.trustpilot.com)). Trustpilot does sell business APIs. **Do not scrape.**
- **Capterra / Gartner Digital Markets.** Not verified (the page needs JS). Treat it like G2.
- **Reddit Data API terms.** Not verified (fetch failed). Reddit is known to restrict commercial use, so confirm the terms before using any Reddit data.
- **Amazon.**
  - PA-API 5 is deprecated (it now returns 403) and has been replaced by the **Creators API**.
  - Eligibility requires **10 qualifying sales in the trailing 30 days**.
  - Recommended cache TTLs are Offers **1 hour** and other fields **1 day**.
  - The licence bans caching images (image links up to 24h), allows other content to be cached up to 24h if refreshed, allows **ASINs to be stored indefinitely**, and requires that apps aim to drive sales to Amazon (Amazon Associates Program / Creators API docs).
  - **Implication:** store only ASIN plus our own descriptions, and fetch price and availability live.
- **Affiliate networks.**
  - **Awin**'s Create-a-Feed covers advertisers you've joined, plus some that auto-join ("soft membership") ([help.awin.com](https://help.awin.com)).
  - **CJ**'s Product Feed API covers joined and non-joined advertisers and needs a personal access token ([developers.cj.com](https://developers.cj.com)).
  - Affiliate links create a **material connection**, so they must be disclosed (16 CFR 255.5, [ecfr.gov](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255)). The FTC also notes affiliate networks can be held liable ([FTC Native Advertising guide](https://www.ftc.gov/business-guidance/resources/native-advertising-guide-businesses)).
- **Common Crawl.**
  - The **September 2026 crawl (CC-MAIN-2026-39)** has **2.17 billion pages** and **361.4 TiB uncompressed**. Compressed: WARC 82.79 TiB, WAT 14.16 TiB, WET 5.89 TiB (commoncrawl.org crawl announcement / stats).
  - Terms of Use (updated 7 Mar 2024): crawled content can be subject to third parties' rights, users indemnify Common Crawl (AI uses included), and legal advice is recommended before commercial use ([commoncrawl.org/terms-of-use](https://commoncrawl.org/terms-of-use)).
  - **Best use:** find vendor homepages, pricing pages and `llms.txt` files, then extract structured facts. Don't redistribute page text.
- **Vendor self-submission.**
  - Our terms should include an explicit licence grant from the vendor.
  - Verify vendors through domain proof (a `/.well-known/` file or DNS TXT, the same pattern the MCP Registry uses for namespaces) and optionally an ERC-8004 identity whose registration file sits at `/.well-known/agent-registration.json` ([eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004)).
  - Any vendor can also expose machine-readable facts through `llms.txt`, an A2A agent card, or an MCP `server.json`, and we can crawl all of these.

### Licensing and ToS rules of thumb (my synthesis, not legal advice)
1. Store **facts plus our own short descriptions plus links**. Don't store third parties' editorial text or reviews.
2. Signals such as downloads, stars, x402 calls and unique payers are facts. Keep the provenance and fetch timestamp for each.
3. **Never scrape** G2, Trustpilot, Capterra or Product Hunt for commercial use. License them or skip them.
4. Treat CC-BY-SA sources (Libraries.io) as a separate layer until legal review.
5. Affiliate or sponsored relationships must appear in the API response (see the design doc).

---

## (b) Storage estimates (ESTIMATES)

### Assumptions (all mine)
- About **2 KB text per item** (name, summary, our description, pros/cons, pricing notes) plus about **1 KB metadata and signals** (JSONB, URLs, scores).
- About **500 tokens embedded per item**.
- Vector bytes use pgvector's formulas: `vector` = 4×dims+8 bytes, `halfvec` = 2×dims+8, `bit` = dims/8+8. HNSW indexes support `vector` up to 2,000 dims and `halfvec` up to 4,000 ([github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)).
- Total = rows + vectors in the heap + an HNSW index at **1.5–2×** the raw vector size. **The index multiplier is my assumption.** HNSW size depends on `m` and `ef_construction`, so measure it on real data.
- Embedding models: `text-embedding-3-small` has 1536 dims at **$0.02/1M tokens**. `text-embedding-3-large` has 3072 dims at **$0.13/1M** and can be shortened with the `dimensions` parameter ([platform.openai.com/docs/pricing](https://platform.openai.com/docs/pricing), [embeddings guide](https://platform.openai.com/docs/guides/embeddings)).
- Prices:
  - Neon storage **$0.35/GB-month**, compute **$0.106/CU-hour** on Launch ([neon.com/pricing](https://neon.com/pricing))
  - Supabase **8 GB disk included, then $0.125/GB** ([supabase.com/pricing](https://supabase.com/pricing))
  - Pinecone storage **$0.33/GB/month**, write units about **$4–4.50 per million** ([pinecone.io/pricing](https://www.pinecone.io/pricing))
  - Hetzner and AWS S3 prices: not verified (the pages are JS-rendered).

### Results

| Items | Vector format | Raw vectors | Rows (3 KB) | **Total incl. HNSW (1.5–2×)** | Neon storage/mo | Supabase extra disk/mo |
|---|---|---|---|---|---|---|
| 1M | 1536 float32 | 6.15 GB | 3.07 GB | 18.5–21.5 GB | $6.46–7.53 | $1.31–1.69 |
| 1M | 1536 halfvec | 3.08 GB | 3.07 GB | 10.8–12.3 GB | $3.77–4.31 | $0.35–0.54 |
| 1M | 512 halfvec | 1.03 GB | 3.07 GB | 5.7–6.2 GB | $1.98–2.16 | $0 (in 8 GB) |
| 1M | 1536 bit (rerank stage) | 0.20 GB | 3.07 GB | 3.6–3.7 GB | ~$1.3 | $0 |
| 10M | 1536 float32 | 61.5 GB | 30.7 GB | 185–215 GB | $64.6–75.4 | $22.1–25.9 |
| 10M | 1536 halfvec | 30.8 GB | 30.7 GB | 108–123 GB | $37.7–43.1 | $12.5–14.4 |
| 10M | 512 halfvec | 10.3 GB | 30.7 GB | 57–62 GB | $19.8–21.6 | $6.1–6.7 |
| 10M | 1536 bit | 2.0 GB | 30.7 GB | 36–37 GB | ~$12.5–12.9 | ~$3.5–3.6 |

- **Pinecone alternative (ESTIMATE):** 1536-dim float32 plus 1 KB metadata comes to about 7.2 GB (**~$2.37/mo**) at 1M items and about 71.7 GB (**~$23.65/mo**) at 10M items for storage. Read and write units come on top.
- **One-off embedding cost (ESTIMATE):** 500 tokens per item gives 0.5B tokens at 1M items, which is **$10** with -3-small or **$65** with -3-large. At 10M items it is 5B tokens, so **$100 / $650**. Re-embedding on updates scales the same way.
- **The real cost is compute and RAM, not disk.** HNSW search is fastest when the index fits in memory. A 10M × 1536 float32 index (~60–120 GB, ESTIMATE) needs a large-memory instance, while 512-dim halfvec (~10–20 GB of index) fits on a mid-size box. **Recommendation:** start with 1536 halfvec, or 512 dims via the `dimensions` parameter, plus Postgres full-text search for hybrid retrieval. Measure recall before you go bigger.
- **Raw-source caches, if kept (ESTIMATE):** the npm package documents for 4.48M packages plus the PyPI JSON for 912k projects would be tens to low hundreds of GB depending on how much we keep. Store only extracted fields. Common Crawl WET for one crawl is 5.89 TiB compressed (cited above), so process it in-stream on AWS and don't store it.
- **Realistic MVP size:** a curated set of **50k–200k items** (dev tools, APIs, x402 services, MCP servers, SaaS) needs **under 2 GB** even at 1536 float32 (ESTIMATE, scaled from the table). That fits the free or entry tier of Neon or Supabase.

---

## (c) Getting agent queries routed to us

### 1. x402 Bazaar / Agentic Market (top priority: these are paying agents)
- **No signup form.** A resource is indexed after its **first settled payment through the CDP facilitator**. The payment must carry the Bazaar extension (`extensions.bazaar` with input/output schema) and `resource` info.
  - Listings with no settlement for **30 days** drop out.
  - Descriptions are capped at **500 characters**.
  - Ranking signals are recomputed every **6 hours**.
  - Listings on ngrok-type domains are down-weighted, and results are capped per domain.
  - There is a free **validation endpoint**, `POST https://api.cdp.coinbase.com/platform/v2/x402/validate`, which needs no key.
  - Curation tiers require **≥99% availability** (above 99.5% for priority), a health probe, and agent-ready metadata.
  - Source: [docs.cdp.coinbase.com/x402/seller/get-discovered](https://docs.cdp.coinbase.com/x402/seller/get-discovered).
- Service metadata: `serviceName` up to 32 ASCII characters, up to 5 tags, an `iconUrl`. Listing is free ([docs.x402.org/extensions/bazaar](https://docs.x402.org/extensions/bazaar)).
- Discovery surfaces: CDP APIs, the Bazaar MCP server, Amazon Bedrock AgentCore and agentic.market (get-discovered page).
- Facilitator fees: first **1,000 on-chain tx/month free, then $0.001/tx**; verification is free; OFAC/KYT screening is included ([docs.cdp.coinbase.com/x402/core-concepts/facilitator](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)).
- **Action:** deploy on our own domain, validate, pay ourselves for the first calls to get indexed, keep traffic organic, and write a keyword-rich 500-character description. Bazaar has no paid placement (prior research), so quality signals are the only lever.

### 2. MCP registries
- **Official MCP Registry** (preview).
  - Publish a `server.json` (schema 2025-12-11) with the `mcp-publisher` CLI: `init` → `login` → `publish`.
  - Namespaces use reverse DNS and are verified via GitHub, DNS or HTTP.
  - Remote (streamable-http) servers are supported. npm packages need `mcpName` in package.json.
  - Aggregators consume the registry downstream.
  - Sources: [modelcontextprotocol.io/registry/quickstart](https://modelcontextprotocol.io/registry/quickstart), [about](https://modelcontextprotocol.io/registry/about).
  - **Action:** publish `com.<ourdomain>/recommend` as a remote server.
- **Smithery.** Publish a URL at smithery.ai/new (Streamable HTTP, OAuth if needed), or use the CLI `smithery mcp publish`. Serve a static server card at `/.well-known/mcp/server-card.json`, and allow the crawler's user agent, `SmitheryBot/1.0` (smithery.ai docs).
- **Glama.** Use "Add MCP Server" with a GitHub repo, and control the listing with `glama.json`. Only GitHub-hosted servers are accepted for now (glama.ai docs), so publish an open-source thin client repo.
- **PulseMCP.** Manual submissions have been paused since **3 Sep 2026**. It recommends the official registry and picks servers up from it automatically (pulsemcp.com).
- **mcp.so.** Web form or a GitHub issue (secondary source).
- **Payment inside MCP.** The x402 docs cover MCP transport, with tool calls paid via x402 (docs.x402.org). Expose free tools such as `list_categories` alongside paid `recommend` tools.

### 3. OpenAI
- **ChatGPT plugin directory (Apps SDK)** ([developers.openai.com/apps-sdk/deploy/submission](https://developers.openai.com/apps-sdk/deploy/submission)):
  - Upload a ZIP and verify the domain with `/.well-known/openai-apps-challenge`.
  - **Auth must be none or OAuth. API keys aren't supported in the portal.**
  - Review needs 5 positive and 3 negative test cases, a demo video, and website, support, privacy and terms URLs.
  - Hosted MCP servers are rescanned daily.
  - displayName and shortDescription are limited to **30 characters**.
  - **Implication:** x402 can't be the auth method in ChatGPT. Offer a free, rate-limited tier, or OAuth linked to prepaid credits.
- **GPT Actions** still exist: Custom GPTs call REST APIs via function calling, using an OpenAPI schema and auth ([platform.openai.com/docs/actions/introduction](https://platform.openai.com/docs/actions/introduction)). Publish an OpenAPI 3.1 spec and a public "Best-Tool Finder" GPT.
- **ChatGPT search visibility.** Allow `OAI-SearchBot`, which is what makes us appear in ChatGPT search; `GPTBot` is for training and is optional. robots.txt changes take about **24h** to apply. The IP list is at openai.com/searchbot.json ([platform.openai.com/docs/bots](https://platform.openai.com/docs/bots)).

### 4. Google
- **A2A agent card.**
  - Serve `/.well-known/agent-card.json` (A2A spec **1.0.0**).
  - Required: `name`, `description`, `supportedInterfaces` (`url`, `protocolBinding` JSONRPC/GRPC/HTTP+JSON, `protocolVersion`), `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, and `skills` (`id`, `name`, `description`, `tags`).
  - Optional: `signatures`, `extensions`.
  - REST binding: `POST /message:send`.
  - Source: [a2a-protocol.org/latest/specification](https://a2a-protocol.org/latest/specification/).
  - The A2A x402 extension is at [github.com/google-agentic-commerce/a2a-x402](https://github.com/google-agentic-commerce/a2a-x402), and Google AP2 is covered in the prior research.
- **Gemini Enterprise Agent Platform** is the evolution of Vertex AI. **Agent Garden** is a library of prebuilt samples and isn't a third-party marketplace.
  - Partner agents reach the **Gemini Enterprise Agent Gallery** by being listed on **Google Cloud Marketplace as "AI Agent as a Service"**. That listing needs an A2A agent card, OAuth/DCR, and the procurement APIs.
  - Enterprise admins can also add their own MCP and A2A agents through the Agent Registry.
  - Sources: Google Cloud blog "Introducing Gemini Enterprise Agent Platform"; docs.cloud.google.com Agent Garden; Google Cloud blog on publishing agents; Gemini Enterprise docs on Marketplace agents.
  - **Action (later):** go for a Cloud Marketplace listing once we have an OAuth/billing path. The A2A card is cheap to add now.
- **Google AI Overviews / AI Mode.** "No additional requirements" beyond normal SEO, and the features use query fan-out ([developers.google.com/search/docs/appearance/ai-features](https://developers.google.com/search/docs/appearance/ai-features)).

### 5. llms.txt and AI-search SEO
- **llms.txt v2** (llmstxt.org, updated 10 Aug 2026):
  - Format: an H1, a blockquote summary, H2 sections of link lists, and an "Optional" section.
  - Offer `.md` versions of pages and link them with `rel="alternate" type="text/markdown"` / `rel="describedby"`.
  - Chrome Lighthouse checks for the file, and OpenAI, Anthropic and Gemini publish their own.
  - Directories: llmstxt.site, directory.llmstxt.cloud, llmstxthub.com.
  - Agentic Market itself publishes one.
- **SEO for AI search (synthesis).**
  - Publish static, crawlable "Best X for Y" category pages generated from our rankings. Each should carry a methodology note and disclosure, with an `.md` twin.
  - These pages are also our top-of-funnel: AI search engines cite them, and agents then find the API through llms.txt and the agent card.

### 6. Other agent directories and identity
- **ERC-8004 identity registry** (draft, 2025-08-13). Register an agent NFT whose `agentURI` points to a registration file listing our A2A and MCP endpoints and `x402Support`. Domain verification uses `/.well-known/agent-registration.json` ([eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004)). Explorers that index 8004 will then find us.
- Other options from the prior research: Virtuals ACP (5% take), Nevermined (1%), and ad networks Operon and Instinct as *demand* channels, meaning they can place our results as a "next call".

### Priority order (my recommendation)
1. Bazaar/CDP (paid traffic)
2. The official MCP Registry, then Smithery and Glama
3. llms.txt, an OpenAPI spec and SEO pages
4. An A2A card and ERC-8004 registration
5. A Custom GPT plus the ChatGPT plugin directory, with a free/OAuth tier
6. Google Cloud Marketplace
