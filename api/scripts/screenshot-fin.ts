import { chromium } from "playwright-core";
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: process.env.DASHBOARD_USER || "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto((process.argv[2] ?? "http://localhost:8402") + "/dashboard/"); await p.click("nav button[data-t=fin]"); await p.waitForTimeout(9000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-financials.png", fullPage: true }); await b.close();
})();
