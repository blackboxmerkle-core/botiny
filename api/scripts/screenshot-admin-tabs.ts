import { chromium } from "playwright-core";
// Admin vertical tabs: settings, wallets, terms, advertisers, bans, audit (read-only navigation).
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto("http://localhost:8402/dashboard/"); await p.waitForTimeout(800);
  await p.click("nav button[data-t=admin]"); await p.waitForTimeout(2000);
  for (const a of ["settings", "wallets", "terms", "advertisers", "bans", "audit"]) {
    await p.click(`#adm-nav button[data-a=${a}]`); await p.waitForTimeout(a === "wallets" ? 8000 : 2000);
    await p.screenshot({ path: `../docs/screenshots/admin-${a}.png` });
  }
  await b.close();
})();
