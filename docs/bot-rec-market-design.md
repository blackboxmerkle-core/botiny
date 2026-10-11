# Bot Product-Recommendation Market on Base: Product Design

Draft, 10 Oct 2026. Companion files: `/workspace/bot-rec-market-research.md` (sources) and `/workspace/crypto-bot-marketplaces.md` (landscape).
All prices below are **proposals**, not market data. Protocol facts are cited.

## 1. Product in one line
A pay-per-query API, also offered as an MCP tool and an A2A skill, that answers "what's the best tool/product/way to do X?". It returns a **ranked, explained shortlist** and gets paid in **USDC on Base via x402**. Organic ranking is never for sale. Sponsored slots are separate and labelled.

**Positioning against the existing landscape** (see the prior research):
- Bazaar/Agentic Market give relevance search with at most 20 results and no opinion ([CDP discover docs](https://docs.cdp.coinbase.com/x402/buyer/discover-services)).
- Operon and Instinct inject ads into responses.
- We are the **neutral, opinionated recommender**. We cover x402 services, MCP servers, dev packages, SaaS and consumer products, and back every answer with verifiable signals.

## 2. API spec

Base URL `https://api.<domain>`. Bodies are JSON. Unpaid calls to priced endpoints get `402`.

### Endpoints
| Method | Path | Price (proposal) | Purpose |
|---|---|---|---|
| POST | `/v1/recommend` | tiered (see §3) | Main query: ranked list |
| GET | `/v1/recommend?q=...&k=5` | `fast` tier | Cache-friendly GET variant |
| GET | `/v1/categories` | free | Taxonomy browse |
| GET | `/v1/items/{id}` | free (rate-limited) | Item detail, signals, sources |
| POST | `/v1/compare` | `standard` | Head-to-head comparison of 2–5 items |
| POST | `/v1/feedback` | free (needs a receipt) | Outcome feedback from paid queries |
| POST | `/v1/vendors/claim` | free | Vendor claims a listing (domain proof) |
| POST | `/v1/sponsor/campaigns` | x402 deposit | Create a sponsored campaign (see §5) |
| GET | `/v1/health` | free | Liveness probe for Bazaar curation |
| GET | `/openapi.json`, `/llms.txt`, `/.well-known/agent-card.json`, `/.well-known/mcp/server-card.json`, `/.well-known/agent-registration.json` | free | Discovery |
| MCP | `https://mcp.<domain>/mcp` (streamable HTTP) | same as REST | Tools: `recommend`, `compare`, `list_categories`, `get_item` |

### `POST /v1/recommend` request
```json
{
  "query": "best way to transcribe 2h podcast audio with speaker labels, cheap",
  "k": 5,
  "tier": "standard",
  "domain_hint": ["api", "saas"],
  "constraints": {
    "max_price_usd_month": 50,
    "payment": ["x402", "card"],
    "open_source": null,
    "region": "EU",
    "must_have": ["diarization"]
  },
  "context": { "agent_stack": "python", "caller_type": "agent" },
  "include_sponsored": true,
  "format": "json"
}
```

### Response (200, plus a `PAYMENT-RESPONSE` header)
```json
{
  "query_id": "q_01JA...",
  "interpreted_intent": "speech-to-text API with diarization, low cost, batch",
  "results": [
    {
      "rank": 1,
      "item_id": "itm_deepgram",
      "name": "Deepgram Nova",
      "type": "api",
      "url": "https://deepgram.com",
      "summary": "Fast STT API with diarization; pay-as-you-go.",
      "why": "Meets diarization + budget; strong uptime; x402-payable endpoint available.",
      "tradeoffs": ["English-first accuracy"],
      "pricing_note": "usage-based; verify live",
      "access": { "x402_endpoint": "https://.../v1/listen", "mcp": null, "docs": "https://..." },
      "scores": { "fit": 0.91, "quality": 0.84, "confidence": 0.78 },
      "signals": { "x402_calls_30d": 18200, "x402_unique_payers_30d": 412, "github_stars": null, "uptime_30d": 0.998, "verified_feedback": 37 },
      "sources": [{ "url": "https://...", "fetched_at": "2026-10-08T12:00:00Z" }],
      "sponsored": false,
      "affiliate": false
    }
  ],
  "sponsored": [
    {
      "label": "Sponsored",
      "disclosure": "Paid placement. Not part of organic ranking. Advertiser: Acme AI.",
      "item_id": "itm_acme_stt",
      "name": "Acme STT",
      "url": "https://acme.example/?ref=rec",
      "summary": "...",
      "relevance_score": 0.72,
      "sponsored": true,
      "bid_influenced": true,
      "campaign_id": "cmp_..."
    }
  ],
  "ranking": { "bid_influenced": false, "method_url": "https://<domain>/methodology", "index_version": "2026-10-10" },
  "billing": { "tier": "standard", "charged_usdc": "0.010000", "network": "eip155:8453" },
  "receipt": "<x402 signed receipt (offer-receipt extension)>"
}
```
Errors: `400` (bad query), `402` (payment required), `422` (no confident answer; with `upto` we charge $0 via the settlement override), `429`.

## 3. x402 payment flow on Base and pricing tiers

The flow follows x402 v2 ([docs.x402.org/core-concepts/http-402](https://docs.x402.org/core-concepts/http-402)):
1. The client calls `POST /v1/recommend` without payment.
2. The server returns **402** with a base64 JSON `PAYMENT-REQUIRED` header listing the accepted options:
```json
{ "x402Version": 2,
  "resource": { "url": "https://api.<domain>/v1/recommend", "description": "Ranked best-tool recommendations for any task", "mimeType": "application/json" },
  "accepts": [
    { "scheme": "exact", "network": "eip155:8453", "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "0xOUR_TREASURY", "maxTimeoutSeconds": 60 },
    { "scheme": "upto", "network": "eip155:8453", "amount": "50000", "asset": "0x8335...2913", "payTo": "0xOUR_TREASURY" },
    { "scheme": "batch-settlement", "network": "eip155:8453", "amount": "10000", "asset": "0x8335...2913", "payTo": "0xOUR_TREASURY" }
  ],
  "extensions": { "bazaar": { "info": { "input": {"...": "schema"}, "output": {"...": "schema"} } }, "offer-receipt": {}, "payment-identifier": {} } }
```
   USDC on Base is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` with 6 decimals, so `10000` = $0.01.
3. The client signs and retries with a `PAYMENT-SIGNATURE` header.
4. The server verifies through the CDP facilitator (verify is free), runs the query, and settles.
5. The server returns **200** with a `PAYMENT-RESPONSE` header (tx hash) and a signed **receipt** from the offer-receipt extension (EIP-712 or JWS; fields include resourceUrl, payer, network, issuedAt, optional txHash) ([docs.x402.org/extensions/offer-receipt](https://docs.x402.org/extensions/offer-receipt.md)).

**Why there are three schemes.**
- `exact` settles on-chain on every call. The CDP facilitator is free for the first 1,000 tx/month, then $0.001/tx ([CDP facilitator](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)). That fee is 10% of a $0.01 query, so `exact` suits occasional callers only.
- `batch-settlement` uses an escrow deposit plus off-chain vouchers, with one on-chain transaction per batch. The default `minDeposit` is 10× the amount, and `setSettlementOverrides` allows dynamic charging ([docs.x402.org/schemes/batch-settlement](https://docs.x402.org/schemes/batch-settlement.md)). It is the default for heavy agent users.
- `upto` authorises a ceiling (Permit2 on EVM) and lets us charge actual cost, or "0" when we have no answer ([docs.x402.org/schemes/upto](https://docs.x402.org/schemes/upto.md)). We use it for the `deep` tier.
- The `payment-identifier` extension gives idempotent retries. The `builder-code` extension (ERC-8021) handles attribution.

**Pricing tiers (PROPOSAL, to be validated against Agentic Market comparables):**
| Tier | What | Price | Scheme | Target latency |
|---|---|---|---|---|
| `fast` | Retrieval and ranking only; cached LLM blurbs | $0.002–0.005 | batch / exact | <500 ms |
| `standard` | Plus a query-specific LLM "why" and tradeoffs | $0.01 | exact / batch | <2 s |
| `deep` | Multi-step research, live pricing checks, compare | up to $0.10 (actual cost) | upto | <20 s |
| Free | 20 queries/day per IP or OAuth user, `fast` only | $0 | none | for ChatGPT, SEO and trials |
| Credits | OAuth account with a prepaid USDC balance | same as above | off-chain ledger | for the ChatGPT plugin directory (no API keys or x402 there) |

**Unit-economics sanity check (ESTIMATE):** a `standard` answer with about 3k input and 400 output tokens on gpt-5-mini ($0.25/$2.00 per 1M tokens, [OpenAI pricing](https://platform.openai.com/docs/pricing)) costs about $0.00075 + $0.0008 ≈ **$0.0016** in LLM spend. That leaves about 84% gross margin before infrastructure at $0.01.

## 4. Ranking and answer generation

Pipeline:
1. **Intent parsing.** A small LLM such as gpt-5-nano turns the query into `{task, category, constraints, must_haves}` and maps it to the taxonomy.
2. **Candidate retrieval (hybrid).** Combine pgvector ANN over item embeddings (halfvec 1536 or 512 dims, see the storage estimates), Postgres full-text (BM25-style), and category and constraint filters. Merge with reciprocal-rank fusion to get about 100 candidates.
3. **Scoring.** `score = w1·fit + w2·quality + w3·freshness + w4·feedback − penalties`.
   - **fit** is the semantic plus constraint match, using a cross-encoder or LLM rerank on the top 30.
   - **quality** blends normalised signals: x402 calls and unique payers over 30 days (from Bazaar), uptime probes, npm/PyPI downloads, GitHub activity, verified feedback, and doc/schema completeness.
   - **penalties** cover stale data, failed probes, unverified vendors, and Sybil-suspect feedback.
   - **Bids are not an input.** This is enforced in code and in a published methodology.
4. **Diversity.** Use MMR so the top-k isn't five near-identical forks.
5. **Answer generation.**
   - The LLM writes `summary`, `why` and `tradeoffs` from stored facts only (retrieval-grounded).
   - It must cite `sources`, and it is not allowed to invent prices: it says "verify live" when no price is fresh.
   - The `fast` tier uses pre-generated per-item blurbs.
6. **Confidence and abstention.** If the best fit is below a threshold, return `422` or a short list with `confidence` flags. Under `upto`, charge $0.
7. **Caching.** Normalised-query cache with a 24h TTL. Popular queries are pre-computed nightly and feed the SEO pages.
8. **Evaluation.** Maintain a golden set of about 500 "best X for Y" queries with human-labelled ideal sets, track nDCG@5 against the deployed index, and A/B rank weights using feedback outcomes.

## 5. Sponsored listings, kept clearly disclosed

Principles, based on the FTC Native Advertising guide and 16 CFR 255 ([FTC guide](https://www.ftc.gov/business-guidance/resources/native-advertising-guide-businesses), [16 CFR 255.5](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255)):
- **A separate array.** Sponsored items go in `sponsored[]` and never into `results[]`. Organic `rank` is computed with bids excluded, and `ranking.bid_influenced: false`.
- **Labelled on every item.** Each item carries `label: "Sponsored"` (or "Ad") plus a human-readable `disclosure` naming the advertiser. The FTC prefers "Ad" or "Sponsored Advertising Content" and advises against vague terms like "Promoted". Mixed groupings must label each ad.
- **The label travels with the content.** Our terms require downstream agents that relay our results to keep the label, because disclosures must survive republication. The MCP tool description and the llms.txt both state this.
- **Machine-readable flags:** `sponsored: true`, `bid_influenced: true`, `campaign_id`, and `affiliate: true` on any organic item with an affiliate link. That last one is a material connection and must be disclosed even when the item is organic.
- **Opt-out.** `include_sponsored: false` (or `no_ads=1`) drops sponsored items. We could charge a slightly higher price for ad-free answers.
- **Relevance floor.** A sponsored item appears only if its relevance is at or above a threshold for the query ("trust outweighs bid", the stance Operon takes per the prior research). At most 1–2 slots, always below or beside organic results, never above them.
- **Mechanics.**
  - Advertisers deposit USDC (an x402 deposit, or the escrow contract below).
  - Bidding is **CPC on click-through**, measured as a follow-up call to the sponsor's URL with a `ref`, or **CPA** using the sponsor's x402 receipts. A second-price auction is weighted by quality × relevance.
  - Every impression is logged with a receipt hash, and advertisers get reporting.
- **Vendor-claimed listings:** vendors can claim and correct facts for free. Claiming does **not** affect rank. A "verified vendor" badge means domain verification only.

## 6. Trust and quality signals
| Signal | Source | Verifiability |
|---|---|---|
| x402 calls / unique payers, 30d | Bazaar/CDP quality data | High (on-chain-backed) |
| Uptime and latency | Our own probes (5-min) | High (ours) |
| Verified-purchase feedback | `/v1/feedback` requires an x402 **receipt** for one of our queries, plus optionally the buyer's receipt from the recommended vendor | High |
| On-chain reputation | ERC-8004 reputation registry: `giveFeedback` with a feedback file that can carry `proofOfPayment`. We read it and also publish our own ([EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)) | Medium (the spec warns about Sybil) |
| Package popularity | npm downloads, PyPI BigQuery downloads | Medium (gameable) |
| Repo health | GitHub/GH Archive activity, release recency | Medium |
| Metadata completeness | Schemas, docs, llms.txt, agent card | High |
| Vendor identity | Domain proof, ERC-8004 identity, MCP-registry namespace | High |
- Anti-gaming: weight unique payers over raw calls, discount wallets that only pay themselves, and cap the influence of new feedback.
- Every result exposes `signals` and `sources` with `fetched_at`, and the response includes our signed receipt, so a calling agent can audit the answer.

## 7. Architecture
```
 Agents ──HTTP/x402──► Edge (Cloudflare) ──► API service (TypeScript, @x402 middleware: hono/express)
   │  MCP / A2A                                 │  ├─ x402 verify/settle ─► CDP facilitator (Base)
   │                                            │  ├─ Rank service ─► Postgres + pgvector (+FTS)
   └─ ChatGPT app (OAuth+credits)               │  ├─ LLM gateway (gpt-5-nano/mini; fallback model)
                                                │  ├─ Redis (cache, rate limit, batch-settlement vouchers)
                                                │  └─ Event log ─► analytics (ClickHouse/BigQuery, later)
 Ingestion workers (queue): npm _changes, PyPI RSS/BigQuery, Bazaar /discovery/resources, MCP Registry API,
   Agentic Market API, GH Archive, affiliate feeds, vendor submissions, Common Crawl extracts
   → normalise → dedupe/entity-resolve → LLM enrich (summary, category) → embed → upsert
 Probers: uptime/latency of listed endpoints; x402 402-header checks
```
- **DB:** Postgres (Neon or Supabase) with tables `items`, `item_sources`, `signals`, `categories`, `queries`, `feedback`, `vendors`, `campaigns` and `impressions`. pgvector with HNSW on `halfvec`.
- **Vector search:** start with pgvector. Move to a dedicated store (Pinecone or Turbopuffer) only past about 10M items or when QPS requires it. See the storage section of the research file.
- **LLM layer:** a provider-agnostic gateway with prompt templates per tier, a JSON-schema-constrained output, a grounding check (every claim must map to a stored fact), and cost metering that feeds `upto` settlement.
- **x402:** use the official x402 SDK middleware and the CDP facilitator. batch-settlement server storage can be file-based or Redis (scheme docs). Register the Bazaar extension metadata.
- **On-chain pieces (all optional for the MVP):**
  1. **Treasury `payTo`.** A Safe multisig on Base. No custom contract is needed for query revenue.
  2. **Payment splitter (later).** When a recommended vendor pays us a referral or CPA fee, or we share revenue with data contributors, a simple splitter (OpenZeppelin-style PaymentSplitter, or 0xSplits) splits USDC between treasury, data partners and affiliate partners.
  3. **Sponsor escrow / listing registry (later).** A contract holds advertiser USDC deposits, records campaign metadata hashes and per-period spend settlements, and lets advertisers withdraw unspent funds. Optionally it emits an `Impression/Click` Merkle root daily for auditability.
  4. **ERC-8004 identity.** Register our agent so 8004 explorers and reputation tools find us. We could also *write* ERC-8004 reputation feedback about the vendors we recommend, based on our probes.
  5. **ERC-8021 builder codes** to attribute x402 traffic we route to vendors.

## 8. MVP scope vs later

**MVP (about 6–8 weeks, ESTIMATE):**
- Verticals: **x402 services plus MCP servers plus dev tools/APIs** (npm/PyPI/GitHub signals). This is the most agent-relevant data and free to use, totalling about 50k–200k items.
- `POST /v1/recommend` with `fast` and `standard` tiers, `exact` and `batch-settlement` on Base, and a free daily tier.
- Hybrid retrieval, an LLM rerank and blurb, and `sources` on every item.
- An MCP server (remote) published to the official registry, Smithery and Glama, plus a Bazaar listing (seeded with self-paid calls), llms.txt, OpenAPI, an A2A card, and ERC-8004 registration.
- `/v1/feedback` with receipts, uptime probers, and a methodology page.
- Sponsored slots: **schema and labels built but turned off**. Launch ads only after organic quality is proven.

**Later:**
- The `deep` tier with `upto`, the compare endpoint, live pricing checks
- Consumer and SaaS verticals through affiliate feeds and Amazon Creators API (only after 10 sales/30d eligibility), and licensed review data
- Sponsored campaigns, the escrow contract and the splitter
- A ChatGPT plugin-directory app with OAuth and credits, a Custom GPT, and a Google Cloud Marketplace "AI Agent as a Service" listing
- Vendor dashboard and analytics, plus a per-query data-licence API for other recommenders
- Multi-chain (CDP supports Polygon, Arbitrum, World and Solana)

## 9. Risks and mitigations
| Risk | Mitigation |
|---|---|
| **Data licensing / ToS** (GitHub resale clause, G2/Trustpilot/Product Hunt bans, CC-BY-SA share-alike) | Store facts, links and our own text only. License the restricted sources, and get legal review before we commercialise |
| **Trust collapse from ads** | Separate array, per-item labels, `bid_influenced`, relevance floor, ads off at launch, public methodology |
| **Undisclosed affiliate links** (FTC 255.5) | `affiliate: true` flag plus disclosure on every affiliated item |
| **Low demand / discovery cold start** | Bazaar requires settled payments and drops listings after 30 days without one. Seed calls, the free tier, MCP registries and SEO pages |
| **Micropayment economics** | batch-settlement for heavy users; `exact` only for occasional callers |
| **Hallucinated recommendations or prices** | Grounding check, `sources` and `fetched_at` on items, "verify live" pricing, abstention under `upto` |
| **Gaming of signals** (wash x402 calls, fake feedback, Sybil 8004 reviews) | Weight unique payers, receipt-gated feedback, wallet-graph heuristics, caps |
| **Platform dependency** (CDP facilitator, OpenAI review rules, Coinbase-run Agentic Market) | Support multiple facilitators. x402 is a Linux Foundation open protocol |
| **Stale data** | Change feeds (npm `_changes`, PyPI RSS, MCP Registry hourly), probers, freshness decay |
| **Regulatory** (stablecoin payments, OFAC) | The CDP facilitator does OFAC/KYT screening. Get counsel on sanctions and on ad/consumer-protection law in target markets |
| **Bazaar/Agentic Market adds their own "best of" ranking** | Differentiate on breadth beyond x402, explanations, and neutrality, and offer a data feed to them |
