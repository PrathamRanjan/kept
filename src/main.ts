import { config } from "./config.js";
import { createApp } from "./app.js";
import { getDb } from "./db.js";
import { scheduleDailyReconcile, startWorker } from "./worker.js";

async function main() {
  const db = await getDb();
  console.log(`[kept] database: ${db.kind}${db.kind === "pglite" ? ` (${config.pglitePath})` : ""}`);
  if (!config.paypal.clientId) console.warn("[kept] PAYPAL_CLIENT_ID is not set: shops must connect their own PayPal app during onboarding.");
  const app = createApp();
  app.listen(config.port, () => console.log(`[kept] listening on ${config.appUrl} (port ${config.port})`));
  if (config.inlineWorker) {
    startWorker();
    await scheduleDailyReconcile();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
