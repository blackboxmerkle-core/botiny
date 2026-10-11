import { chromium } from "playwright-core";
// Financials (relayer gas per chain), Transactions (by chain), Admin (ToS editor), request detail with ToS proof. Read-only.
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto("http://localhost:8402/dashboard/");
  await p.click("nav button[data-t=fin]"); await p.waitForTimeout(12000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-financials-multichain.png", fullPage: false });
  await p.click("nav button[data-t=tx]"); await p.waitForTimeout(9000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-transactions-multichain.png", fullPage: false });
  await p.click("nav button[data-t=admin]"); await p.waitForTimeout(2500);
  await p.screenshot({ path: "../docs/screenshots/dashboard-admin-tos.png", fullPage: false });
  if (process.env.REQ) { await p.evaluate(`openReq("${process.env.REQ}")`); await p.waitForTimeout(2500); await p.screenshot({ path: "../docs/screenshots/request-detail-tos.png", fullPage: false }); }
  await b.close();
})();
