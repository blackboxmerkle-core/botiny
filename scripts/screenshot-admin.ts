import { chromium } from "playwright-core";
// Admin, Financials and Bots tabs. NOTE: the Bots shot runs ONE real paid testnet search (0.001 USDC) unless SKIP_TRY=1.
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  await p.goto("http://localhost:8402/dashboard/");
  await p.click("nav button[data-t=admin]"); await p.waitForTimeout(2500);
  await p.screenshot({ path: "docs/dashboard-admin.png", fullPage: true });
  await p.click("nav button[data-t=fin]"); await p.waitForTimeout(9000);
  await p.screenshot({ path: "docs/dashboard-financials.png", fullPage: true });
  await p.click("nav button[data-t=bots]"); await p.waitForTimeout(1000);
  if (!process.env.SKIP_TRY) {
    await p.selectOption("#tb-bot", "research-bot"); await p.fill("#tb-q", "x402 data search API over public datasets"); await p.fill("#tb-k", "5");
    await p.click("#tb-go"); await p.waitForSelector("#tb-rp", { state: "attached", timeout: 60000 });
    await p.click("#tb-out button.act"); await p.waitForTimeout(1500);
  }
  await p.screenshot({ path: "docs/dashboard-bots-try.png", fullPage: true });
  await b.close();
})();
