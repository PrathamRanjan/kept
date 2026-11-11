import { config } from "./config.js";
import { getDb } from "./db.js";
import { Handler, JobType, runDueJobs, enqueue } from "./jobs.js";
import * as svc from "./service.js";
import { listMerchants } from "./store.js";
import { processWebhook } from "./webhooks.js";
import { deliver } from "./channels/index.js";
import { sendPush } from "./channels/push.js";
import { checkWallet } from "./demo/wallet.js";
import { ensureShowcase, expireIdle, rebuildShowcase } from "./demo/workspaces.js";
import { syncPool } from "./demo/pool.js";
import { runNightly } from "./eval/nightly.js";

export const handlers: Record<JobType, Handler> = {
  process_webhook: (p) => processWebhook(p.eventId),
  reactivate: (p) => svc.reactivate(p.subscriberId),
  revert_promo: (p) => svc.revertPromo(p.subscriberId),
  expire_offer: (p) => svc.expireOffer(p.offerId),
  payment_followup: (p) => svc.paymentFollowup(p.subscriberId),
  reconcile: async (p) => {
    if (p.merchantId) await svc.reconcileMerchant(p.merchantId);
    else for (const m of await listMerchants(await getDb())) await svc.reconcileMerchant(m.id);
  },
  sync_subscription: (p) => svc.syncSubscription(p.ref, "scheduler").then(() => undefined),
  retry_cancel: (p) => svc.retryCancel(p),
  /* foundation (roadmap B.8, K5, K6) */
  send_channel_message: (p) => deliver(p.messageId),
  send_push: (p) => sendPush(p.subscriptionId, p.payload),
  renewal_reminders: () => svc.sendRenewalReminders().then(() => undefined),
  invoice_check: () => svc.checkInvoices().then(() => undefined),
  /* Wave 1 */
  wallet_check: () => checkWallet().then(() => undefined),
  workspace_expiry: () => expireIdle().then(() => undefined),
  pool_sync: () => syncPool().then(() => undefined),
  showcase_rebuild: () => rebuildShowcase().then(() => undefined),
  /* Wave 2 (A5.6): the daily showcase run; only where a model key is set, so tests and keyless installs skip it */
  showcase_eval: () => runNightly("schedule").then(() => undefined),
};

export async function tick(): Promise<number> {
  return runDueJobs(await getDb(), handlers);
}

let timer: NodeJS.Timeout | null = null;
let slow: NodeJS.Timeout | null = null;

export function startWorker(intervalMs = config.workerIntervalMs) {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (e) {
      console.error("[kept worker]", (e as Error).message);
    } finally {
      busy = false;
    }
  }, intervalMs);
  // Slow loop: renewal reminders and invoice read-backs every 10 minutes (deduplicated by day).
  slow = setInterval(() => scheduleSlowJobs().catch((e) => console.error("[kept worker]", (e as Error).message)), 10 * 60_000);
  // And once shortly after boot, so a restart never waits ten minutes for expiry or the pool read-back.
  setTimeout(() => scheduleSlowJobs().catch((e) => console.error("[kept worker]", (e as Error).message)), 5_000).unref();
  console.log(`[kept] worker running every ${intervalMs} ms`);
}

export async function scheduleSlowJobs() {
  const db = await getDb();
  const stamp = new Date().toISOString().slice(0, 13);
  await enqueue(db, "renewal_reminders", {}, new Date(), `reminders:${stamp}`);
  await enqueue(db, "invoice_check", {}, new Date(), `invoices:${stamp}`);
  await enqueue(db, "wallet_check", {}, new Date(), `wallet:${stamp.slice(0, 10)}`);
  // Demo workspaces: idle expiry and pool read-back hourly; the showcase is rebuilt once a day at 04:00 UTC.
  await enqueue(db, "workspace_expiry", {}, new Date(), `wsexpire:${stamp}`);
  await enqueue(db, "pool_sync", {}, new Date(), `pool:${stamp}`);
  const day = stamp.slice(0, 10);
  const at = new Date(`${day}T04:00:00Z`);
  if (Date.now() > at.getTime()) at.setUTCDate(at.getUTCDate() + 1);
  try {
    await ensureShowcase(db);
    await enqueue(db, "showcase_rebuild", {}, at, `showcase:${at.toISOString().slice(0, 10)}`);
    if (config.ai.provider === "openai" && config.ai.openaiKey) {
      const ev = new Date(at.getTime() + 30 * 60_000);
      await enqueue(db, "showcase_eval", {}, ev, `showcase_eval:${ev.toISOString().slice(0, 10)}`);
    }
  } catch {
    /* no showcase shop on this server (tests, a fresh install): nothing to rebuild */
  }
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  if (slow) clearInterval(slow);
  timer = null;
  slow = null;
}

export async function scheduleDailyReconcile() {
  const db = await getDb();
  const next = new Date();
  next.setUTCHours(3, 0, 0, 0);
  if (next.getTime() < Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  await enqueue(db, "reconcile", {}, next, `reconcile:${next.toISOString().slice(0, 10)}`);
}
