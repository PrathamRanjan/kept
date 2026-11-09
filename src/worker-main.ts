import { getDb } from "./db.js";
import { scheduleDailyReconcile, startWorker } from "./worker.js";

/** Render background worker: runs jobs (webhook processing, scheduled resumes, offer expiry, follow-ups). */
(async () => {
  await getDb();
  await scheduleDailyReconcile();
  startWorker();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
