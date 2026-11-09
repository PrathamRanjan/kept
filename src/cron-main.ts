import { getDb } from "./db.js";
import { enqueue } from "./jobs.js";

/** Render cron job: queue a full reconcile with PayPal; the worker runs it. */
(async () => {
  const db = await getDb();
  await enqueue(db, "reconcile", {}, new Date(), `reconcile:cron:${new Date().toISOString().slice(0, 13)}`);
  console.log("[kept cron] reconcile queued");
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
