# admin/ — Botiny admin UI notes

There is no standalone admin app in this directory yet. The UI lives in the API dashboard at `/dashboard` (HTTP basic auth) and in the human portal at `/portal` (SIWE).

## Dashboard (basic auth)

Served by `api/` (`api/public/dashboard.html`, `api/src/dashboard.ts`, `api/src/admin.ts`, `api/src/crawlerAdmin.ts`).

Admin and operations tabs include:

- **Pricing and ranking** — versioned settings (query price, credit packs, feed tiers, promo-v4 floors and slots)
- **Advertisers** — accounts, manual test credits, unlink (audited)
- **Incentives** — reports, pacing, settlement, clawback, review-clear
- **Wallets** — public pay-to and relayer addresses; relayer rotation (the new key is generated server-side and is never shown in the repo)
- **Bans** — wallet and IP bans, revoke
- **Terms of Service** — each save creates a new version
- **Suggestions** — review listing suggestions from the portal
- **Audit** — recent admin actions
- **Crawler** — source health, runs, jobs, items, dedup review, lead pipeline
- **Usage, financials, requests, catalogue** — operational views, including prepaid credits and data-feed cards

JSON under `/dashboard/api/…`. CSRF and lockout protections apply. “Try a search” is disabled in hardened configs so the payer key cannot be spent from the browser.

## Portal

Advertisers and bot owners sign in with SIWE and use `/portal`. The static front end is not in this folder; `PORTAL_APP_DIR` defaults to a sibling `botiny-brand/portal-app` checkout. The API only serves an allow-list of `*.html` and `assets/`.

This directory is reserved for a future standalone admin app.
