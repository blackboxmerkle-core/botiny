# MCP server and data-feed subscription

Testnet only. Migration `0011_data_feed.sql`.

## MCP server (`POST /mcp`)

- **Transport**: MCP streamable HTTP. It is stateless: each POST carries one JSON-RPC message or a batch, and the reply is `application/json`. Notifications get `202`. `GET` and `DELETE` return `405`. Supported protocol versions are 2025-06-18, 2025-03-26 and 2024-11-05. A browser `Origin` header from any other host is refused (DNS-rebinding guard).
- **Auth**: `Authorization: Bearer bck_…`, the prepaid search-credit key from `POST /v1/credits/topup`. `initialize` and `tools/list` work without a key.
- **Tools**:
  - `botiny_search {query, k}`: debits `query_price_atomic` credits. It runs `executeSearch()`, the same transaction as a credit-paid `POST /v1/recommend`. Each call is logged with `payment_method='credits'` and `bot_id` set to `mcp` (or `X-Bot-Id`), along with its impressions and ledger debit. It returns `request_id`, `response_hash` and a `verify` replay URL.
  - `botiny_listing {listing_id}`: full listing details. No debit.
  - `botiny_credit_balance {}`: balance, queries remaining and recent usage. No debit.
- **Errors** are returned as tool results with `isError: true`, and every one points to `/v1/credits/topup` with pricing:
  - `credit_key_required`: no key sent
  - `credit_key_invalid`: unknown or revoked key
  - `insufficient_credit`: balance below the per-query fee
- The per-wallet rate limit and wallet bans apply, the same as for credit searches.
- **stdio**: `BOTINY_CREDIT_KEY=bck_… BOTINY_MCP_URL=https://<host>/mcp npx tsx src/mcp-stdio.ts` (run from `api/`). It forwards newline-delimited JSON-RPC to `/mcp`.

## Data feed (bulk catalogue access)

| Endpoint | |
|---|---|
| `GET /v1/feed/tiers` | Tiers, prices, quotas and `tos_params` for the ToS nonce binding |
| `POST /v1/feed/subscribe?tier=basic\|pro[&rotate_key=1]` | x402 payment, ToS-bound, bans apply. Grants a 30-day period that starts now, or is queued after the wallet's current period. The first purchase (or `rotate_key=1`) returns a `bfk_…` key bound to the payer wallet. The key is shown once and only its sha256 is stored. |
| `GET /v1/feed/listings?cursor=&limit=` | Snapshot export of current listings in seq order. The first page pins `catalogue_seq` into the opaque `next_cursor`, so later pages stay consistent. `limit` is capped at the tier's `max_page`. |
| `GET /v1/feed/changes?since=<seq>&limit=` | Incremental change feed: every catalogue row with seq > `since`. The catalogue is append-only: `op:"add"`, or `op:"update"` with `replaces` set to the superseded `listing_id`. Resume from `next_since`. |
| `GET /v1/feed/me` | Active period, previous periods and 30-day usage. Does not consume quota. |

- Each `listings` or `changes` request consumes one unit of the active period's quota atomically (no overselling under concurrency), and every request is logged in `feed_usage`, including 402s and 429s.
- With no active quota the response is `402 feed_quota_exhausted`, pointing to `/v1/feed/subscribe`.
- There are no refunds.
- The per-wallet rate limit is `RL_FEED_WALLET` (120/min).
- **Admin settings** (versioned):
  - basic: `feed_basic_price_atomic` 500000 (0.5 test USDC), `feed_basic_quota` 2000 requests/month, `feed_basic_max_page` 200
  - pro: `feed_pro_price_atomic` 2000000, `feed_pro_quota` 20000, `feed_pro_max_page` 1000
- **Visibility**: the dashboard's API usage tab has a "Data feed subscriptions" card (`/dashboard/api/feed`). Financials show the `data_feed_purchase` type.
- **Ambiguous settlement**: the purchase goes to `topup_pending` (`target=feed_basic|feed_pro`) and the sweeper grants the month if the payment settled.
- **Script**: `tsx --env-file=.env scripts/feed-subscribe.ts [basic|pro] [--rotate] [--no-buy]`. The key is written to `~/.botiny/data-feed.key` (0600) and is never printed.
