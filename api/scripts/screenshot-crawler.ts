import { chromium } from "playwright-core";
// Crawler tab: one screenshot per sub-tab (read-only; clicks only navigation + opens one item).
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto("http://localhost:8402/dashboard/");
  await p.click("nav button[data-t=crawl]"); await p.waitForTimeout(2500);
  for (const c of ["src", "runs", "jobs", "items", "dedup", "leads"]) {
    await p.click(`#cr-nav button[data-c=${c}]`); await p.waitForTimeout(2500);
    if (c === "items") { await p.click("#cr-items tr.click"); await p.waitForTimeout(1500); }
    await p.screenshot({ path: `../docs/screenshots/crawler-${c}.png`, fullPage: c !== "leads" && c !== "dedup" });
  }
  await p.click("nav button[data-t=cat]"); await p.waitForTimeout(2500); await p.fill("#filter", "crawled"); await p.waitForTimeout(800);
  await p.screenshot({ path: "../docs/screenshots/catalogue-crawled.png" });
  await b.close();
})();
