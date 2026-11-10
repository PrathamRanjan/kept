/** Web push for the Kept PWA (roadmap B.8). VAPID keys from env; without them, or with no browser subscribed, the log records the push as not sent. */
import type { Party } from "./index.js";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { enqueue } from "../jobs.js";
import { newId } from "../lib/ids.js";

export const pushReady = () => Boolean(config.channels.vapidPublic && config.channels.vapidPrivate);

export async function subscribe(party: Party, partyId: string, subscription: unknown) {
  const db = await getDb();
  await db.query("INSERT INTO push_subscriptions (id, party, party_id, subscription) VALUES ($1,$2,$3,$4)", [newId("push"), party, partyId, JSON.stringify(subscription)]);
}

export async function pushTo(party: Party, partyId: string, payload: { title: string; body: string; url?: string }) {
  const db = await getDb();
  const subs = (await db.query<{ id: string }>("SELECT id FROM push_subscriptions WHERE party = $1 AND party_id = $2", [party, partyId])).rows;
  for (const s of subs) await enqueue(db, "send_push", { subscriptionId: s.id, payload }, new Date(), `push:${s.id}:${Date.now()}`);
  await db.query("INSERT INTO channel_messages (id, channel, direction, address, body, status) VALUES ($1,'push','out',$2,$3,$4)", [newId("msg"), `${party}:${partyId}`, `${payload.title}: ${payload.body}`, subs.length && pushReady() ? "queued" : "not_sent"]);
}

export async function sendPush(subscriptionId: string, payload: { title: string; body: string; url?: string }) {
  if (!pushReady()) return;
  const db = await getDb();
  const row = (await db.query<{ subscription: any }>("SELECT subscription FROM push_subscriptions WHERE id = $1", [subscriptionId])).rows[0];
  if (!row) return;
  const webpush = await import("web-push");
  webpush.default.setVapidDetails(`mailto:ops@${new URL(config.appUrl).hostname}`, config.channels.vapidPublic, config.channels.vapidPrivate);
  try {
    await webpush.default.sendNotification(row.subscription, JSON.stringify(payload));
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await db.query("DELETE FROM push_subscriptions WHERE id = $1", [subscriptionId]);
    else throw e;
  }
}
