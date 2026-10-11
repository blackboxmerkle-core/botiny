import { createApp } from "./app";
import { migrateAll as migrate } from "./db";
migrate().then(() => { const port = Number(process.env.PORT ?? 8402); createApp().listen(port, () => console.log(`bot-rec-market on :${port}`)); });
