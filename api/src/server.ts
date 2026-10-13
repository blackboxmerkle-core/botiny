import { createApp } from "./app";
import { migrateAll as migrate } from "./db";
migrate().then(() => { const port = Number(process.env.PORT ?? 8402); import("./clicks").then(m => m.startSettlementLoop()); import("./attest").then(m => { if (m.startAttestationLoop()) console.log("click attestation loop on"); }); const app = createApp();
  // Loopback only: ngrok's agent connects locally. API_HOST may list several hosts (default IPv4 + IPv6 loopback, since ngrok dials "localhost").
  for (const host of (process.env.API_HOST ?? "127.0.0.1,::1").split(",").map(h => h.trim()).filter(Boolean))
    app.listen(port, host, () => console.log(`bot-rec-market on ${host}:${port}`)).on("error", (e: any) => console.error(`listen ${host}:${port} failed: ${e?.code ?? e}`)); });
