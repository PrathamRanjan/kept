import { config } from "./config.js";
import { getDb } from "./db.js";
import { Handler, JobType, runDueJobs, enqueue } from "./jobs.js";
import * as svc from "./service.js";
import { listMerchants } from "./store.js";
import { processWebhook } from "./webhooks.js";
import { deliver } from "./channels/index.js";
import { sendPush } from "./channels/push.js";

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
  console.log(`[kept] worker running every ${intervalMs} ms`);
}

export async function scheduleSlowJobs() {
  const db = await getDb();
  const stamp = new Date().toISOString().slice(0, 13);
  await enqueue(db, "renewal_reminders", {}, new Date(), `reminders:${stamp}`);
  await enqueue(db, "invoice_check", {}, new Date(), `invoices:${stamp}`);
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
