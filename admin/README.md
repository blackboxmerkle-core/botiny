# admin/: crawler monitoring & management UI

For now the UI lives in the existing dashboard served by `api/` (`/dashboard`, basic auth), in the **Crawler** tab, which has these sub-tabs:
Source health (run, pause or resume a source), Run history, Jobs (enqueue, retry, pause, resume or cancel), Items browser (and item detail),
Dedup review (merge or distinct) and Lead pipeline. Backend: `api/src/crawlerAdmin.ts` (`/dashboard/api/crawler/*`). Worker: `crawler/`.
This directory is reserved for a future standalone admin app.
