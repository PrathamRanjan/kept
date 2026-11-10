import { config } from "./config.js";
import { createApp } from "./app.js";
import { getDb } from "./db.js";
import { hasOpenAI } from "./ai/provider.js";
import { scheduleDailyReconcile, startWorker } from "./worker.js";

/** Spec A11: in production nothing quietly stands in for a missing model or PayPal app. Start-up stops instead. */
export function productionProblems(): string[] {
  if (!config.production) return [];
  const out: string[] = [];
  if (!hasOpenAI()) out.push("AI_PROVIDER=openai and OPENAI_API_KEY are required in production (no rules brain stands in for the model).");
  if (config.brain !== "openai") out.push("KEPT_BRAIN must be openai in production.");
  if (!config.paypal.clientId || !config.paypal.clientSecret) out.push("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in production.");
  if (!process.env.DATABASE_URL) out.push("DATABASE_URL is required in production (PGlite is for local runs and tests).");
  return out;
}

async function main() {
  const problems = productionProblems();
  if (problems.length) {
    for (const p of problems) console.error(`[kept] refusing to start: ${p}`);
    process.exit(1);
  }
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
