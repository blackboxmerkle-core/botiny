import { chromium } from "playwright-core";
// Usage tab → "Result click analytics" card (CTR by segment / rank / listing). Read-only.
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto("http://localhost:8402/dashboard/"); await p.waitForSelector("#clk-seg tr:nth-child(2)", { timeout: 20000 }); await p.waitForTimeout(1000);
  await p.locator("#clk-card").screenshot({ path: "../docs/screenshots/usage-click-analytics.png" });
  await b.close();
})();
