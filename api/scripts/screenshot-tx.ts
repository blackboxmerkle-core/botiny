import { chromium } from "playwright-core";
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto("http://localhost:8402/dashboard/"); await p.click("nav button[data-t=tx]"); await p.waitForTimeout(9000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-transactions.png", fullPage: true });
  await p.click("nav button[data-t=req]"); await p.waitForTimeout(1000); await p.click("#reqs tr.click"); await p.waitForTimeout(800);
  await p.click("#detail button.act"); await p.waitForTimeout(1200);
  await p.screenshot({ path: "../docs/screenshots/dashboard-request-replay.png", fullPage: true }); await b.close();
})();
