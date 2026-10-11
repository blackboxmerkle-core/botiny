import { chromium } from "playwright-core";
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "admin", password: process.env.DASHBOARD_PASSWORD! } });
  const errs: string[] = []; p.on("pageerror", e => errs.push(e.message)); p.on("response", r => { if (r.status() >= 400 && r.status() !== 402) errs.push(r.status() + " " + r.url()); });
  await p.goto("https://rephrase-theme-serotonin.ngrok-free.dev/dashboard/", { waitUntil: "networkidle" });
  if (await p.$("text=Visit Site")) await p.click("text=Visit Site");
  await p.click("nav button[data-t=req]"); await p.waitForTimeout(2000);
  while (await p.isVisible("#reqs-more")) { await p.click("#reqs-more"); await p.waitForTimeout(1200); }
  console.log(await p.textContent("#reqs-end"), await p.textContent("#reqs-count"));
  await p.click("#reqs tr.click >> nth=-1"); await p.waitForTimeout(1200);
  await p.click("#detail button.act"); await p.waitForTimeout(1500);
  console.log("oldest:", (await p.textContent("#detail"))!.slice(0, 120).replace(/\s+/g, " "), "|", await p.textContent("#rp"));
  await p.fill("#reqs-q", "f7ba4ccc"); await p.click("#reqs-go"); await p.waitForTimeout(1000); await p.click("#reqs tr.click"); await p.waitForTimeout(1000);
  console.log("settle_failed:", (await p.textContent("#detail"))!.match(/settle error[^R]*/)?.[0]);
  for (const t of ["tx", "fin", "bots", "admin", "adv", "cat"]) { await p.click(`nav button[data-t=${t}]`); await p.waitForTimeout(3000); }
  console.log("errors:", JSON.stringify(errs));
  await b.close();
})();
