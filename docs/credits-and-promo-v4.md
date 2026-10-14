# Prepaid search credits and the promo-v4 ranker

Testnet only (Base Sepolia test USDC). Migration `0010_search_credits.sql`.

## Prepaid search credits (searcher bots)

Credits work like the advertiser prepaid balance: an append-only ledger (`search_credit_ledger`), x402 top-ups that are credited only after settlement, a balance that can never go negative (checked inside the transaction), and no refunds.

| Endpoint | Purpose |
|---|---|
| `GET /v1/credits/pricing` | Pack price, credit granted, per-query fee, and the `tos_params` used for the ToS nonce binding |
| `POST /v1/credits/topup[?rotate_key=1]` | Pays one pack with x402. The ToS is bound into the EIP-3009 nonce over `{route:"/v1/credits/topup", params:{pack_price_atomic}}`, and bans apply. The first top-up from a wallet returns a `bck_…` API key bound to the payer wallet. The key is shown once and only its sha256 is stored. `rotate_key=1` issues a new key and revokes the old one, because the settled payment proves the bot controls the wallet. |
| `POST /v1/recommend` with `Authorization: Bearer bck_…` | Debits `query_price_atomic` atomically, in the same DB transaction as the request log, response hash, impressions, advertiser debits and click links. The request is stored with `payment_method='credits'` and `payment_status='settled'`, plus a `query_debit` ledger row. It replays like any other request. |
| `GET /v1/credits/me` (Bearer key) | Balance, usage and the last 50 ledger rows |

- **Insufficient balance**: the response is the normal 402 x402 challenge (`accepts` + `tos`) with an extra `credits` object, so pay-per-query is still available as the fallback. Sending `X-PAYMENT` together with a key always uses pay-per-query.
- **Rate limits**: the per-IP `recommend` limit applies, and there is a per-wallet limit (`RL_RECOMMEND_WALLET`, 300/min) keyed by the key's wallet. Wallet bans block both search and top-up.
- **ToS**: a credit search records the ToS version, hash and proof from that wallet's latest top-up.
- **Ambiguous settlement**: the top-up goes to `topup_pending` (`target='search_credits'`) and the existing sweeper credits it if it settled on-chain. If this was the wallet's first top-up, use `rotate_key=1` on a later top-up to get a key.
- **Visibility**: the dashboard's API usage tab has a "Prepaid search credits" card (`/dashboard/api/credits`). The portal's `GET /v1/bots/me` returns `credits` for the owned wallets. Financials count credit top-ups (`bot_credit_topup`) as cash, not each credit-debited query.
- **Script**: `tsx --env-file=.env scripts/credits-topup.ts [N] [--rotate] [--no-topup]` buys one pack with `PAYER_PRIVATE_KEY` (capped at 1 test USDC) and runs N credit searches. The key is written to `~/.botiny/search-credit.key` (0600) and is never printed.

### Settings (Admin → Pricing & ranking, versioned)
- `credit_pack_price_atomic`: default 1,000,000 (1 test USDC)
- `credit_pack_credit_atomic`: default 1,000,000. At the default `query_price_atomic` of 1000 this is 1000 queries.

## promo-v4 ranker (default)

`RANKER_VERSION = RANKER_V4 = "promo-v4;…"`. `rank()` dispatches on the **stored** `ranker_version`: v4, v3, v2 or v1. Old requests therefore replay with the ranker that produced them. Live check after the deploy: 623 of 623 logged requests replay with a MATCH.

- Organic results are the candidates with score ≥ `relevance_threshold_ppm`, in pure relevance order.
- Sponsored candidates need score ≥ `sponsored_floor_ppm` (default 250000, which is above the organic 150000; saving a lower floor is rejected). They must also be funded for the fixed fee plus the bid.
- There are at most `min(sponsored_slots_max, promoted_slots, 2)` sponsored slots. `sponsored_slots_max` defaults to 1 and can be at most 2; `promoted_slots=0` still turns ads off. Sponsored results are always placed first and labelled `Sponsored`.
- Sponsored order is `floor(score / relevance_band_ppm)` descending, then bid, then the capped pacing boost, then score and listing_id. The band width defaults to 50000.
- A sponsored result displaces organic results only through those capped slots.
