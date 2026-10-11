import { chromium } from "playwright-core";
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto("http://localhost:8402/dashboard/"); await p.waitForTimeout(2000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-usage-bots.png", fullPage: true });
  await p.click("nav button[data-t=fin]"); await p.waitForTimeout(9000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-financials.png", fullPage: true });
  await b.close();
})();
