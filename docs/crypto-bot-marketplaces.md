# Crypto-Settled Marketplaces for AI Agents and Bots

*Research brief, prepared 10 October 2026 (Europe/London). Sources are official sites and docs unless marked otherwise, all accessed 10 Oct 2026. A figure appears only where a source states it. "Not stated" means none of the sources I reviewed gave the figure.*

---

## Executive summary

- **Bot-to-bot commerce is live, but small.** Virtuals' Agent Commerce Protocol (ACP), Olas Mech Marketplace, Coinbase's x402 Bazaar / Agentic Market, Nevermined and Fetch.ai Agentverse all let software agents discover, hire and pay other agents. Settlement is mostly in **USDC on Base**, or in a native token (OLAS, FET/ASI, MOR, TAO).
- **Take rates vary from near-zero to 30%.** Virtuals ACP takes 5% (it was 10% before v2). Nevermined charges 1% on stablecoin plans. Olas takes a DAO fee on withdrawals. The CDP x402 facilitator is free for the first 1,000 transactions a month, then $0.001 per transaction. Cryptohopper's human-facing trading-bot marketplace takes 30%, or 15% for exclusive sellers.
- **Bot-to-bot advertising is at a very early stage.** I found two live, x402-native ad networks aimed at agents: **Operon** (sponsored placements inside agent responses, 100 USDC minimum) and **Instinct / x402ads.io** (sponsored "next call" recommendations stamped onto x402 settlement responses, with CPM/CPC/CPA bids). **Telegram Ads** is the largest crypto-paid ad market I found (paid in TON, 50% revenue share to channel and bot owners), but it sells human attention, not agent attention.

---

## Comparison table

| # | Marketplace | What's sold | Buyers ↔ sellers | Token / chain | Fee model | Ads/attention? | Status |
|---|---|---|---|---|---|---|---|
| 1 | Virtuals ACP | Agent services (jobs), fund-managed jobs | Agent↔agent (plus humans via Butler) | USDC (v2); VIRTUAL for launchpad; Base | 5% protocol; +5% optional evaluator | No dedicated ad product | Live (v2, Apr 2026) |
| 2 | Olas Mech Marketplace | AI tools/tasks (predictions, LLM, data) | Agent↔agent | Native gas token, OLAS, USDC; multi-chain | DAO fee on withdrawal | No | Live |
| 3 | x402 Bazaar / Agentic Market (Coinbase) | Pay-per-call APIs, MCP tools | Agent→API (machine-to-machine) | USDC; Base, Solana (+ others listed) | Free listing; facilitator free to 1k tx/mo, then $0.001/tx | Directory only (no paid placement) | Live |
| 4 | Nevermined | Payment plans/credits for agents and APIs | Agent↔agent, human→agent | Any ERC-20 (USDC, EURC); Base; also fiat | 1% on stablecoin plans | No | Live |
| 5 | Fetch.ai Agentverse / ASI:One | Agent services discovered by ASI:One LLM | Human→agent, agent↔agent | FET (ASI); also USDC via Skyfire, Stripe | Not stated | Discovery/visibility via ASI:One routing (not paid ads) | Live |
| 6 | SingularityNET AI Marketplace | Pay-per-call AI services | Human/dev→service | ASI (FET) on Ethereum; PayPal on-ramp | Not stated | No | Live (AGIX legacy deprecated) |
| 7 | Bittensor subnets | Digital commodities (inference, compute, storage, prediction) | Miners↔validators; protocol emissions | TAO + per-subnet alpha | Emissions split 18/41/41 | No | Live |
| 8 | Morpheus Inference Marketplace | LLM inference by session time | Consumer (human/agent)→provider | MOR on Base | Bid fee 0.3 MOR; refundable stakes | No | Live (API gateway in beta) |
| 9 | ElizaOS ecosystem (Elisym plugin etc.) | Paid agent jobs | Agent↔agent | SOL/USDC on Solana; x402 integrations | Not stated | No | Software active; ELIZAOS token wound down Aug 2026 |
| 10 | Telegram Ads (TON) | Sponsored messages in channels and bots | Human/business advertisers → channel/bot owners | TON (Toncoin); Stars as ad credit | 50% revenue share to owners | **YES: attention marketplace (human eyeballs)** | Live |
| 11 | Cryptohopper Marketplace | Trading strategies, templates, signals | Human sellers → human/bot users | Fiat sales; crypto payouts via BitPay | 30% platform cut (15% exclusive) | No | Live |
| 12 | **Operon** | Native ad placements in AI-agent responses | **Agent/merchant advertisers → agent publishers** | USDC on Base via x402 | Auction (CPM default); 100 USDC min deposit | **YES: bot-to-bot ads** | Live (v1) |
| 13 | **Instinct (x402ads.io)** | Sponsored "next API" recommendations in x402 settlements | **API sellers → paying agents** | x402 (USDC) | CPA/CPC/CPM bids | **YES: bot-to-bot ads** | Live (early) |
| 14 | Google AP2 + A2A x402 extension | Payment protocol (not a marketplace) | Agent↔agent | Stablecoins via x402 | n/a | No | Spec published Sep 2025 |

---

## Detailed profiles

### 1. Virtuals Protocol: Agent Commerce Protocol (ACP)
- **What it is:** A framework for "secure, transparent, and verifiable commerce between autonomous AI agents", with each transaction recorded on-chain. ACP v2.0 is the reference implementation of the proposed **ERC-8183** agent-commerce standard. ([whitepaper.virtuals.io: ACP Concepts](https://whitepaper.virtuals.io/acp/acp-concepts-terminologies-and-architecture))
- **What's sold:** Provider agents publish "Offerings", each with a name, a USDC price (fixed or percentage), an SLA and a deliverable. Doc examples are "Generate an Image" for 0.1 USDC and "Analyze Dataset" for 5 USDC. Fund-managed jobs, such as swaps, can be priced as a percentage of principal. ([os.virtuals.io: Core Concepts](https://os.virtuals.io/acp/concepts/); [ACP Changelogs](https://whitepaper.virtuals.io/acp/acp-changelogs))
- **Who buys/sells:** Client agents hire Provider agents, and an optional Evaluator agent checks the work, so this is bot-to-bot. Humans reach it through Virtuals' "Butler" agent. ([ACP Current Status](https://whitepaper.virtuals.io/builders-hub/acp-current-status))
- **Payment:** The fee is escrowed in a Job smart contract and settled in **USDC**. Launchpad modules are paid in VIRTUAL.
- **Fees:** Without an evaluator, 95% goes to the provider and 5% to the protocol. With an evaluator, the split is 90% provider, 5% evaluator, 5% protocol. ([whitepaper](https://whitepaper.virtuals.io/acp/acp-concepts-terminologies-and-architecture)) An older v1 status page describes a 10% treasury tax, a 30% agent-token buy-back and 60% to the agent. ([ACP Current Status](https://whitepaper.virtuals.io/builders-hub/acp-current-status))
- **Scale:** Virtuals says "over 2,000 agents onboarded" after 18 months in production. ([ACP Changelogs](https://whitepaper.virtuals.io/acp/acp-changelogs)) A third-party report (Fundstrat, June 2026) estimates **~$4.5M in cumulative gross ACP fees and ~$452k in protocol revenue**. ([Fundstrat PDF](https://fundstrat.com/wp-content/uploads/2026/06/Virtuals-Q2-2026-Update-FSGA-Final.pdf); secondary source)
- **Status:** Live. v2 launched April 2026, per Fundstrat.
- **Ads/attention:** No dedicated ad product. The docs mention an "Autonomous Media House" category of agents, but that sells content, not ad inventory.

### 2. Olas (Autonolas): Mech Marketplace
- **What it is:** Smart contracts that relay on-chain requests from requester agents to "Mechs", which are agents selling task-based services. If a Mech fails to deliver, another can step in. ([stack.olas.network: Mech Server](https://stack.olas.network/mech-server/))
- **What's sold:** AI tools such as prediction/forecasting, LLM access and data. Olas describes Mechs as "subscription-free tool libraries with a standard interface". ([Olas Mech](https://olas.network/agent-economies/mech))
- **Who buys/sells:** Agent to agent. Olas markets it as "the ultimate bazaar for AI Agents" for A2A collaboration. ([olas.network/mech-marketplace](https://olas.network/mech-marketplace))
- **Payment:** Per-request payment in the chain's native token (xDAI, ETH, MATIC), OLAS or USDC, or a Nevermined subscription (Gnosis and Base only). ([Mech Client docs](https://stack.olas.network/mech-client/))
- **Fees:** A DAO fee is taken when a Mech withdraws its payments. Non-OLAS fees go to the Olas Treasury and OLAS fees are burned. ([Olas Mech](https://olas.network/agent-economies/mech))
- **Scale (official, as of 10 Oct 2026 06:40 UTC):** Total task payments **$109,864.03**. Mech earnings withdrawn **$102,786.30**. Fees collected **$845.66**, counting only certain assets and only since the fee went live on 15 June 2026. ([Olas Mech](https://olas.network/agent-economies/mech))
- **Status:** Live on multiple chains (Gnosis, Base, Ethereum, Arbitrum, Optimism, Polygon, Celo and others).
- **Ads/attention:** No.

### 3. Coinbase x402: Bazaar discovery layer and Agentic Market
- **What it is:** x402 is an HTTP-402 payment protocol, now under the Linux Foundation. The **Bazaar** is "a machine-readable catalog that helps developers and AI agents find and integrate with x402-compatible API endpoints and MCP tools." ([docs.x402.org: Bazaar](https://docs.x402.org/extensions/bazaar)) **Agentic Market** is a Coinbase-operated directory built on it. ([agentic.market](https://agentic.market))
- **What's sold:** Pay-per-call APIs and MCP tools covering inference, data, search, media, social (email, phone), infra and travel. Agentic Market lists **3,169 services** as of 10 Oct 2026, with typical per-call prices from $0.001 to $1 USDC. ([agentic.market](https://agentic.market))
- **Who buys/sells:** Machine to machine. Agents discover services through a public search API that needs no API key, then pay automatically. ([CDP: Discover services](https://docs.cdp.coinbase.com/x402/buyer/discover-services))
- **Payment:** USDC on Base and Solana, plus their testnets. ([docs.x402.org](https://docs.x402.org/extensions/bazaar)) Some listings show further networks.
- **Fees:** Listing is free and sellers set their own per-call price. ([docs.x402.org](https://docs.x402.org/extensions/bazaar)) The CDP facilitator is free for 1,000 transactions a month, then $0.001 per transaction, with no processor or chargeback fees. ([CDP facilitator docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator))
- **Ranking:** Search ranking blends relevance with quality signals, including call count and unique payers over 30 days. ([CDP docs](https://docs.cdp.coinbase.com/x402/buyer/discover-services)) **There is no paid placement.** That is the gap Instinct and Operon target (see #12–13).
- **Status:** Live.

### 4. Nevermined
- **What it is:** Payments and metering infrastructure for AI agents. Sellers define "Payment Plans" (credits, time-based or dynamic) and settle through Nevermined's programmable x402 facilitator (ERC-4337 smart accounts with session keys). It also supports MPP and card payments. ([Nevermined x402](https://nevermined.ai/docs/development-guide/nevermined-x402); [Payment Models](https://nevermined.ai/docs/integrate/patterns/payment-models))
- **What's sold:** Access to agents, APIs and tools. The docs example is 10 USDC for 100 credits.
- **Who buys/sells:** "Agents with wallets can purchase plans and pay per request autonomously, with no human in the loop." ([Stablecoin Payments](https://nevermined.ai/docs/integrate/patterns/stablecoin-payments))
- **Payment:** Any ERC-20, such as USDC or EURC, settled on-chain on Base. Fiat is available through Stripe and others.
- **Fees:** **1% of plan price** for stablecoins, with no processing surcharge. ([Stablecoin Payments](https://nevermined.ai/docs/integrate/patterns/stablecoin-payments))
- **Status:** Live. Olas Mechs also use it for subscriptions.
- **Ads/attention:** No.

### 5. Fetch.ai: Agentverse and ASI:One (ASI Alliance)
- **What it is:** A registry and marketplace for discovering uAgents. Agents register in the Almanac contract and the ASI:One LLM routes user queries to them. ([Agentverse Marketplace docs](https://agentverse.ai/docs/marketplace); [ASI Network](https://network.fetch.ai/))
- **What's sold:** Agent functions such as real-time data, bookings and image generation. One doc example charges 0.1 FET per generated image. ([FET image agent example](https://innovationlab.fetch.ai/resources/docs/next/examples/agent-transaction/fet-image-agent-payment-protocol))
- **Who buys/sells:** Humans through ASI:One, and agent to agent through the **Agent Payment Protocol**. In that protocol the seller sends RequestPayment, the buyer answers with CommitPayment or RejectPayment, and the seller closes with CompletePayment or CancelPayment. ([Agent Payment Protocol](https://innovationlab.fetch.ai/resources/docs/agent-transaction/agent-payment-protocol))
- **Payment:** FET on the Fetch.ai ledger (`fet_direct`), USDC via Skyfire, or fiat via Stripe. The protocol is "payment-rail agnostic".
- **Fees:** No marketplace take rate is stated in the docs I reviewed. FET is used for agent registration. ([FET intro](https://network.fetch.ai/docs/guides/network/intro-fet-token))
- **Ads/attention:** No paid ads. Fetch.ai does present registration as a way to gain visibility and monetization when ASI:One routes queries to your agent, so routing acts as an attention allocator.
- **Status:** Live.

### 6. SingularityNET AI Marketplace
- **What it is:** A decentralized marketplace for AI services, settled through Multi-Party Escrow (MPE) payment channels on Ethereum. ([MPE docs](https://dev.singularitynet.io/docs/products/DecentralizedAIPlatform/CoreConcepts/SmartContracts/mpe/))
- **What's sold:** Pay-per-call AI services, often with free trial calls.
- **Who buys/sells:** Developers and humans buy from service publishers.
- **Payment:** **ASI (FET)** is the default token. AGIX is legacy and deprecated. ([AGIX→ASI migration](https://dev.singularitynet.io/docs/products/DecentralizedAIPlatform/AGIXToASIMigration/)) A PayPal option converts fiat into ASI (FET) in a channel. ([Payment methods](https://dev.singularitynet.io/docs/products/AIMarketplace/payment-methods/))
- **Fees:** No platform take rate is stated. Calls inside a channel are off-chain with no per-call gas; opening, funding and claiming a channel cost gas. ([I am AI Consumer](https://dev.singularitynet.io/docs/products/DecentralizedAIPlatform/IAmAIConsumer/))
- **Status:** Live at marketplace.singularitynet.io.
- **Ads/attention:** No.

### 7. Bittensor subnets
- **What it is:** "An open network where independent subnets produce digital commodities — compute, inference, storage, prediction — and the chain pays participants in its token, TAO." ([Bittensor docs](https://docs.bittensor.com/dynamic-tao/emission))
- **Market mechanics:** This is an incentive market, not a storefront. Miners produce, validators score and stakers back validators. Each subnet's alpha emission is split **18% to the subnet owner, 41% to miners and 41% to validators/stakers**. Since June 2026, TAO emission is allocated across subnets by EMA alpha price, with a miner-burn penalty and a Hill-function gate. ([bittensor.com: Emissions](https://www.bittensor.com/docs/concepts/emissions); [taostats: TAO emission](https://taostats.io/docs/concepts/how-emission-works/tao-emission))
- **Payment:** TAO plus per-subnet alpha tokens on the Subtensor chain.
- **Who buys/sells:** Mostly bot-to-protocol: miners are automated. End-user demand flows through subnet owners' own products.
- **Status:** Live (dTAO since February 2025).
- **Ads/attention:** I found no ad-specific subnet in primary sources during this research. Not verified either way.

### 8. Morpheus: Inference Marketplace
- **What it is:** A peer-to-peer inference marketplace coordinated by "Compute Node" (Diamond) contracts on **Base**. Providers register models and bids, consumers open escrowed sessions, and traffic flows directly between proxy-routers. ([Morpheus Inference Marketplace](https://gitbook.mor.org/morpheus-inference-marketplace); [Architecture](https://nodedocs.mor.org/concepts/architecture))
- **What's sold:** LLM inference, priced per second of session time (`pricePerSecond`) rather than per token. TEE-tagged models are available.
- **Who buys/sells:** Consumers (apps, agents, humans via an API gateway) buy from compute providers. Provider ranking uses reputation: uptime, TTFT, throughput, success rate and stake. ([rating-config](https://nodedocs.mor.org/reference/rating-config))
- **Payment / fees:** MOR (ERC-20). Provider stake is 0.2 MOR (10,000 for a subnet), model registration 0.1 MOR, and each bid costs a **non-refundable 0.3 MOR**. ([P-Node quickstart](https://nodedocs.mor.org/providers/full/quickstart); [Register on chain](https://nodedocs.mor.org/providers/full/register-onchain))
- **Status:** Live. The API Gateway is "free during Beta testing".
- **Ads/attention:** No.

### 9. ElizaOS / ai16z ecosystem
- **What it is:** An open-source agent framework, not a marketplace in itself. Paid agent-to-agent commerce happens through plugins. One example is **Elisym**, an ElizaOS plugin "for running a paid elisym provider agent (Nostr + Solana)", with discovery over Nostr and payment on Solana. ([GitHub: plugin-elizaos-elisym](https://github.com/elisymlabs/plugin-elizaos-elisym)) The search summary I used also said providers can charge in SOL or USDC; I didn't confirm that on the repo page. x402 integrations have also been proposed. ([elizaOS issue #6668](https://github.com/elizaOS/eliza/issues/6668))
- **Token status:** Several outlets reported on 5 Aug 2026 that the founder called the ELIZAOS (formerly AI16Z) token "dead" and that the foundation is winding down. They also say the open-source software continues. ([CoinDesk](https://www.coindesk.com/markets/2026/08/05/ai-agent-token-once-worth-usd2-4-billion-ends-with-founder-calling-it-dead); [The Block](https://www.theblock.co/news/defi/2026-08-05-eliza-labs-native-token-dead-410774); secondary sources)
- **Fees/scale:** Not stated.
- **Ads/attention:** No.

### 10. Telegram Ads paid in TON ⚑ ATTENTION MARKET
- **What it is:** Telegram's ad platform for sponsored messages in large public channels and bots, purchasable with **Toncoin**. ([Telegram blog: Sharing Revenue with Channel Owners](https://telegram.org/blog/monetization-for-channels))
- **What's sold:** Ad impressions in channels and bots. Advertisers "choose the exact channels" for context targeting. The ads are not based on user data.
- **Who buys/sells:** Businesses, bot developers and channel owners buy. Any bot or channel can be promoted, "with budgets as low as a handful of Toncoins". Channel owners with at least 1,000 subscribers, and bot owners, receive **50% of ad revenue**. ([Telegram blog](https://telegram.org/blog/monetization-for-channels); [core.telegram.org: Channel and bot ad revenue](https://core.telegram.org/api/revenue))
- **Payment:** TON. Withdrawals go through Fragment. Telegram Stars can be spent on ads at **0.02 USD in ad credit per Star**, though that value "may fluctuate". ([Content Creator ToS](https://telegram.org/tos/content-creator-rewards))
- **Fees:** 50% share to owners, "subject to change at any time" at Telegram's discretion.
- **Relevance:** This is a large crypto-settled attention market, but buyers and audiences are humans. Bot owners do take part as publishers, and buyers often advertise bots, but the impressions are human.

### 11. Cryptohopper Marketplace (trading-bot strategies and signals)
- **What it is:** A marketplace inside the Cryptohopper trading-bot platform. Sellers list strategies and templates (one-off price) and signals (monthly subscription). ([Seller settings docs](https://docs.cryptohopper.com/docs/sellers/what-are-the-different-settings-for-adding-a-strategy-or-template-as-a-marketplace-seller/))
- **Fees:** Cryptohopper takes **30%**, or **15%** for sellers in the Exclusivity Program. ([Exclusivity Program](https://docs.cryptohopper.com/docs/sellers/exclusivity-program))
- **Payment:** Seller payouts are available in crypto via BitPay (including USDT) or PayPal, with a $75 minimum and a 6-week hold. ([Withdraw earnings](https://docs.cryptohopper.com/docs/sellers/withdraw-earnings); [payout update blog](https://www.cryptohopper.com/blog/affiliate-and-marketplace-seller-crypto-payout-update-cryptohopper-10511))
- **Who buys/sells:** Human sellers, with humans and their bots as buyers. Signals are consumed by bots.
- **Ads/attention:** No.

### 12. Operon ⚑ BOT-TO-BOT ADS
- **What it is:** "The x402-callable advertiser API for the Operon network. Headless merchants, autonomous agents, and any HTTP client can buy native ad placements in AI agent responses." ([operon.so/x402](https://operon.so/x402))
- **What's sold:** Native, disclosed ("via operon") recommendations in agent responses across a publisher network. Targeting is by category (defi, fintech, travel, insurance, ecommerce, saas, health, education, general), asset and intent (research, comparison, recommendation, transaction).
- **Who buys/sells:** Advertisers can be fully autonomous: "No account, no API key, no humans." The publishers are AI agents.
- **Payment:** **100 USDC minimum deposit on Base via x402**. Unspent balance is refundable through `DELETE` (processed manually within 7 days in v1).
- **Pricing/auction:** The bid defaults to a mid-range CPM for the category and can be overridden. Ranking uses a trust score built from endpoint reliability and integrity, and Operon states that "trust outweighs bid". Stats include impressions, wins, click-throughs and average clearing price.
- **Scale:** Operon names a "live demand pool" of ChangeNOW, SimpleSwap, Jupiter and Megapot. No volume figures are given.
- **Status:** Live on Base mainnet (v1).

### 13. Instinct (x402ads.io) ⚑ BOT-TO-BOT ADS
- **What it is:** "A performance ad network for AI agents." It reads x402 settlement activity (which resource an agent just paid for) and stamps a sponsored "recommended next call" onto the settlement receipt, the JSON body and the tool output. ([x402ads.io](https://x402ads.io/))
- **What's sold:** Recommendation slots in agent workflows. API developers bid to be the recommended next endpoint.
- **Pricing:** Bids per conversion, click or impression. Instinct argues that conversions are on-chain settlements, so "faking a conversion would mean making a real payment".
- **Payment:** x402 (USDC). Exact chains and take rate are not stated on the page.
- **Status:** Live and early. No scale figures are published.
- **Related early projects (unverified, not primary-reviewed):** `@forgemeshlabs/x402-ads` (npm) and AgentSense (open-source keyword-auction middleware, reportedly on a testnet). Both surfaced in search; I didn't confirm either.

### 14. Google AP2 + A2A x402 extension (rail, not a marketplace)
- Google announced the Agent Payments Protocol (AP2) on 16 Sep 2025 alongside an A2A x402 extension for agent-based stablecoin payments. ([Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol); [a2a-x402 spec](https://github.com/google-agentic-commerce/a2a-x402)) It matters as a likely common payment layer underneath future agent marketplaces, including ad markets.

---

## Flags: advertising and attention sold bot-to-bot

| Venue | Bot-to-bot? | Notes |
|---|---|---|
| **Operon** | **Yes.** Agent/merchant advertisers pay via x402; ads are placed in agent responses | 100 USDC min; CPM auction with trust-weighted ranking |
| **Instinct (x402ads.io)** | **Yes.** Sponsored next-call recommendations to paying agents | CPA/CPC/CPM; conversions verified by on-chain payment |
| Telegram Ads (TON) | No. Human audiences; bots and channels are publishers and advertised products | 50% revenue share; the largest crypto-paid attention market found |
| Fetch.ai ASI:One routing | Partial. Algorithmic routing gives "visibility", not paid ads | Possible future paid-ranking surface |
| x402 Bazaar / Agentic Market | No. Organic ranking (relevance plus 30-day call/payer quality) | No sponsored slots: an open gap |
| Virtuals ACP, Olas, Nevermined, SingularityNET, Morpheus, Bittensor, Cryptohopper | No | No ad products found |

---

## Gaps and opportunities for a bot-to-bot ads market

1. **Discovery is the bottleneck, and no major catalog sells placement.** The x402 Bazaar (3,169 services on Agentic Market), Agentverse, Olas and Virtuals ACP all rank providers organically or algorithmically. A neutral "sponsored listings" layer that plugs into several catalogs, priced per agent impression or per paid call, has no incumbent. Only Operon and Instinct are attacking it, both early and both x402/Base-only.
2. **Conversions can be verified on-chain.** An agent ad "converts" when the agent pays the advertised endpoint, a fact Instinct already relies on. This could make CPA in agent ads much harder to defraud than web ads. There is room for a cross-protocol attribution standard that would let one conversion receipt work across x402, ACP jobs, Olas Mech requests and Nevermined credits.
3. **Trust and quality scoring is not standardised.** Operon weights trust over bid, CDP ranks by calls and payers, and Morpheus scores providers on uptime and latency. A portable reputation oracle that ad auctions can use, possibly tied to ERC-8183 job outcomes or Olas delivery records, would reduce the risk of ads steering agents to bad endpoints.
4. **Rails are fragmented.** Settlement is split across USDC on Base and Solana, native tokens (OLAS, FET, MOR, TAO), TON and Stars. An ad exchange that accepts several rails and pays publishers in their native token, such as Telegram bot owners in TON or Virtuals agents in USDC, would serve more of the market.
5. **Agent publishers have no monetization primitive.** Telegram already shares 50% of ad revenue with bot owners, but for human-facing ads. Nothing comparable exists for agents that answer other agents. An SDK that lets any ACP, Olas or x402 provider insert disclosed sponsored suggestions into responses, with a revenue share, would be new.
6. **Disclosure and safety norms aren't set.** Operon labels placements "via operon", but there is no shared standard for marking sponsored content to downstream LLMs, or for buyers to opt out. A spec (for example an x402 extension field such as `sponsored: true`, with buyer-side filters) could become a differentiator and head off regulatory risk.
7. **Scale evidence is thin.** The only primary-source volume figures I found are Olas (~$110k in all-time task payments) and Virtuals' own count of 2,000+ agents onboarded. Fundstrat's ~$4.5M gross ACP fees is a secondary estimate. Agent-commerce volume is still small, so an ads market would probably have to start alongside the commerce layer and help it grow.

---

### Source notes
- Primary sources: official docs and sites of Virtuals, Olas, Coinbase CDP / x402 / Agentic Market, Nevermined, Fetch.ai, SingularityNET, Bittensor, Morpheus, Telegram, Cryptohopper, Operon, x402ads.io and Google.
- Secondary sources, marked inline: the Fundstrat report (Virtuals revenue), CoinDesk and The Block (ELIZAOS token), and Taostats (a Bittensor explorer whose docs describe chain mechanics).
- Live figures (Olas, Agentic Market service count) were read on 10 Oct 2026 and will change.
