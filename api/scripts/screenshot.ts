import { chromium } from "playwright-core";
// Usage: tsx scripts/screenshot.ts [baseUrl]  -> ../docs/screenshots/dashboard-*.png
(async () => {
  const base = process.argv[2] ?? "http://localhost:8402";
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  await p.goto(base + "/dashboard/"); await p.waitForTimeout(1500);
  await p.screenshot({ path: "../docs/screenshots/dashboard-usage.png", fullPage: true });
  await p.click("nav button[data-t=tx]"); await p.waitForTimeout(8000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-transactions.png", fullPage: true });
  await p.click("nav button[data-t=cat]"); await p.waitForTimeout(1000);
  await p.screenshot({ path: "../docs/screenshots/dashboard-catalogue.png", fullPage: true });
  await p.click("nav button[data-t=req]"); await p.waitForTimeout(1000);
  if (await p.$("#reqs tr.click")) {
    await p.click("#reqs tr.click"); await p.waitForTimeout(800); await p.click("#detail button.act"); await p.waitForTimeout(1000);
    await p.screenshot({ path: "../docs/screenshots/dashboard-request-replay.png", fullPage: true });
  }
  await b.close();
})();
