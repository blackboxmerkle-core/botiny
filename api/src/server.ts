import { createApp } from "./app";
import { migrateAll as migrate } from "./db";
migrate().then(() => { const port = Number(process.env.PORT ?? 8402); import("./clicks").then(m => m.startSettlementLoop()); import("./attest").then(m => { if (m.startAttestationLoop()) console.log("click attestation loop on"); }); createApp().listen(port, () => console.log(`bot-rec-market on :${port}`)); });
