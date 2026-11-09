import type { Request, Response } from "express";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { enqueue } from "./jobs.js";
import { paypalFor } from "./paypal/index.js";
import * as svc from "./service.js";
import { logEvent, merchantById, subscriberById, subscriberByPayPalId } from "./store.js";

function subscriptionIdOf(event: any): string | null {
  const r = event?.resource ?? {};
  if (String(event?.event_type ?? "").startsWith("BILLING.SUBSCRIPTION.")) return r.id ?? null;
  return r.billing_agreement_id ?? r.supplementary_data?.related_ids?.subscription_id ?? null;
}

/**
 * PayPal webhook receiver. Events are verified with PayPal's verify-webhook-signature API using the
 * webhook id of the PayPal app that owns the subscription, stored once (deduplicated by event id),
 * and processed by the worker. Unverified events are stored for inspection but never acted on.
 */
export async function receiveWebhook(req: Request, res: Response) {
  const db = await getDb();
  const event = req.body;
  if (!event?.id || !event?.event_type) return res.status(400).json({ error: "not a PayPal event" });
  const ppSubId = subscriptionIdOf(event);
  const sub = ppSubId ? await subscriberByPayPalId(db, ppSubId) : null;
  const merchant = sub ? await merchantById(db, sub.merchant_id) : null;
  const webhookId = merchant?.paypal_webhook_id || config.paypal.webhookId;
  let verified = false;
  try {
    if (webhookId) verified = await paypalFor(merchant).verifyWebhookSignature(req.headers as Record<string, string>, event, webhookId);
  } catch {
    verified = false;
  }
  const inserted = await db.query(
    "INSERT INTO webhook_events (id, event_type, resource_id, body, verified) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id",
    [event.id, event.event_type, ppSubId, JSON.stringify(event), verified],
  );
  if (!verified) {
    if (merchant) await logEvent(db, { merchantId: merchant.id, subscriberId: sub?.id, source: "webhook", type: "webhook.rejected", summary: `Rejected ${event.event_type}: signature not verified` });
    return res.status(400).json({ error: "signature verification failed" });
  }
  if (inserted.rows.length) await enqueue(db, "process_webhook", { eventId: event.id }, new Date(), `wh:${event.id}`);
  return res.status(200).json({ ok: true });
}

export async function processWebhook(eventId: string) {
  const db = await getDb();
  const row = (await db.query<{ body: any; processed_at: Date | null; verified: boolean }>("SELECT body, processed_at, verified FROM webhook_events WHERE id = $1", [eventId])).rows[0];
  if (!row || row.processed_at || !row.verified) return;
  const event = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
  const ppSubId = subscriptionIdOf(event);
  const sub = ppSubId ? await subscriberByPayPalId(db, ppSubId) : null;
  if (sub) {
    await logEvent(db, { merchantId: sub.merchant_id, subscriberId: sub.id, source: "webhook", type: `webhook.${event.event_type}`, summary: `PayPal webhook ${event.event_type} (verified)` });
    if (event.event_type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
      await svc.handlePaymentFailed(sub.id, "webhook");
    } else {
      const after = await svc.syncSubscription(sub.ref, "webhook");
      if (event.event_type === "PAYMENT.SALE.COMPLETED" && after.kept_state === "payment_failed" && after.outstanding <= 0) {
        await svc.paymentFixed(after.ref, { kind: "system" });
      }
    }
  }
  await db.query("UPDATE webhook_events SET processed_at = now() WHERE id = $1", [eventId]);
}

