/**
 * The approval pool (spec A2.2). PayPal Subscriptions need the buyer's own approval for each subscription and
 * will not take the saved demo wallet (probed 10 Nov 2026: both `payment_source.paypal.vault_id` and
 * `subscriber.payment_source.token` come back APPROVAL_PENDING). So real members for demo workspaces come from
 * here: subscriptions created on the showcase's plans, approved once by the owner as the sandbox buyer, then
 * claimed one at a time into a visitor's workspace.
 *
 * - `refillPool(n)` creates N subscriptions and returns their approval links (status `awaiting_approval`).
 * - `syncPool()` reads each one back from PayPal: approved and ACTIVE → `ready`; cancelled or expired → `spent`.
 * - `claimForWorkspace(ws)` takes ready items inside a transaction, re-reads each from PayPal before use, tags the
 *   subscription's `custom_id` with "<shop>:<member>" and records it in `paypal_refs`.
 * Nothing here invents an id: when the pool is empty the workspace has no real member, and the page says why.
 */
import { config } from "../config.js";
import { getDb } from "../db.js";
import { newId, requestKey } from "../lib/ids.js";
import { paypalFor } from "../paypal/index.js";
import { PayPalError } from "../paypal/types.js";
import { logEvent, merchantById, planByPayPalId, plansFor, subscriberByPayPalId } from "../store.js";
import { POOL_PER_WORKSPACE, showcase, workspaceById, type Workspace } from "./workspaces.js";

export interface PoolItem {
  id: string;
  kind: string;
  paypal_id: string;
  plan_id: string | null;
  approve_url: string | null;
  status: "awaiting_approval" | "ready" | "claimed" | "spent";
  claimed_by_ws: string | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function poolCounts() {
  const rows = (await (await getDb()).query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM approval_pool GROUP BY status")).rows;
  const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { ready: n("ready"), awaiting: n("awaiting_approval"), claimed: n("claimed"), spent: n("spent") };
}

export async function listPool(limit = 100): Promise<PoolItem[]> {
  return (await (await getDb()).query<PoolItem>("SELECT * FROM approval_pool ORDER BY created_at DESC LIMIT $1", [limit])).rows;
}

/** Creates `count` subscriptions on the showcase's daily plan (or `planName`) for the owner to approve. */
export async function refillPool(count: number, planName?: string): Promise<{ created: PoolItem[]; plan: string }> {
  const db = await getDb();
  const m = await showcase(db);
  const plans = await plansFor(db, m.id);
  const plan = (planName ? plans.find((p) => p.name.toLowerCase().includes(planName.toLowerCase())) : null) ?? plans.find((p) => p.interval_unit === "DAY") ?? plans.find((p) => p.kind === "regular");
  if (!plan?.paypal_plan_id) throw new Error("The showcase has no PayPal plan to create pool subscriptions on.");
  const created: PoolItem[] = [];
  const n = Math.max(1, Math.min(25, Math.floor(count)));
  for (let i = 0; i < n; i++) {
    const id = newId("pool");
    const out = await paypalFor(m).createSubscription(
      { planId: plan.paypal_plan_id, customId: `pool:${id}`, brandName: m.name, returnUrl: `${config.appUrl}/demo/pool/approved?id=${id}`, cancelUrl: `${config.appUrl}/demo/pool/approved?id=${id}&cancelled=1` },
      requestKey("pool", id),
    );
    // Read back before recording: the pool holds only what PayPal says exists.
    const pp = await paypalFor(m).getSubscription(out.id);
    await db.query("INSERT INTO approval_pool (id, paypal_id, plan_id, approve_url, status, note) VALUES ($1,$2,$3,$4,'awaiting_approval',$5)", [id, out.id, plan.paypal_plan_id, out.approveUrl, `created on ${plan.name}; PayPal reads back ${pp.status}`]);
    created.push((await db.query<PoolItem>("SELECT * FROM approval_pool WHERE id = $1", [id])).rows[0]);
  }
  await logEvent(db, { merchantId: m.id, source: "system", type: "pool.refilled", summary: `${created.length} pool subscription(s) created on ${plan.name}, waiting for the sandbox buyer's approval` });
  return { created, plan: plan.name };
}

/** Reads every unclaimed item back from PayPal and moves it to ready or spent. */
export async function syncPool(): Promise<{ checked: number; ready: number; spent: number; errors: number }> {
  const db = await getDb();
  const m = await showcase(db);
  const items = (await db.query<PoolItem>("SELECT * FROM approval_pool WHERE status IN ('awaiting_approval','ready') ORDER BY created_at LIMIT 100")).rows;
  const out = { checked: 0, ready: 0, spent: 0, errors: 0 };
  for (const it of items) {
    out.checked++;
    try {
      const pp = await paypalFor(m).getSubscription(it.paypal_id);
      if (["ACTIVE", "SUSPENDED"].includes(pp.status)) {
        if (it.status !== "ready") await db.query("UPDATE approval_pool SET status = 'ready', note = $2, updated_at = now() WHERE id = $1", [it.id, `PayPal reads back ${pp.status}`]);
        out.ready++;
      } else if (["CANCELLED", "EXPIRED"].includes(pp.status)) {
        await db.query("UPDATE approval_pool SET status = 'spent', note = $2, updated_at = now() WHERE id = $1", [it.id, `PayPal reads back ${pp.status}`]);
        out.spent++;
      } else if (it.status === "ready") {
        await db.query("UPDATE approval_pool SET status = 'awaiting_approval', note = $2, updated_at = now() WHERE id = $1", [it.id, `PayPal reads back ${pp.status}`]);
      }
    } catch (e) {
      // PayPal's sandbox removes a subscription nobody approved; its approval link is dead from then on. Retire it
      // so the admin page stops offering a link that can't work. Any other failure stays as it was, with its reason.
      if (e instanceof PayPalError && (e.status === 404 || e.name_ === "INVALID_RESOURCE_ID" || /INVALID_RESOURCE_ID|RESOURCE_NOT_FOUND/.test(e.message))) {
        await db.query("UPDATE approval_pool SET status = 'spent', note = $2, updated_at = now() WHERE id = $1", [it.id, "PayPal no longer has this subscription (not approved in time), so its approval link is dead"]);
        out.spent++;
        continue;
      }
      out.errors++;
      await db.query("UPDATE approval_pool SET note = $2, updated_at = now() WHERE id = $1", [it.id, `read failed: ${(e as Error).message.slice(0, 160)}`]);
    }
  }
  return out;
}

/** Turns one PayPal subscription (already marked claimed by `ws`) into a real member of that workspace. */
export async function adoptIntoWorkspace(ws: Workspace, paypalId: string): Promise<{ ok: boolean; ref?: string; note: string }> {
  const db = await getDb();
  const m = await merchantById(db, ws.tenant_id);
  if (!m) return { ok: false, note: "workspace has no shop" };
  const pp = await paypalFor(m).getSubscription(paypalId);
  if (!["ACTIVE", "SUSPENDED"].includes(pp.status)) {
    await db.query("UPDATE approval_pool SET status = 'spent', note = $2, updated_at = now() WHERE paypal_id = $1", [paypalId, `PayPal read back ${pp.status} at claim time`]);
    return { ok: false, note: `PayPal reads ${paypalId} back as ${pp.status}` };
  }
  const existing = await subscriberByPayPalId(db, paypalId);
  if (existing) {
    if (existing.merchant_id === m.id) return { ok: true, ref: existing.ref, note: "already a member" };
    await db.query("UPDATE approval_pool SET status = 'spent', note = $2, updated_at = now() WHERE paypal_id = $1", [paypalId, "already a member of another shop"]);
    return { ok: false, note: `${paypalId} already belongs to another shop` };
  }
  const plan = await planByPayPalId(db, m.id, pp.plan_id);
  if (!plan) {
    // Every workspace clones the showcase's plans, so an item on another plan is of no use to any of them.
    await db.query("UPDATE approval_pool SET status = 'spent', claimed_by_ws = NULL, note = $2, updated_at = now() WHERE paypal_id = $1", [paypalId, `plan ${pp.plan_id} is not one of the showcase's plans`]);
    return { ok: false, note: `plan ${pp.plan_id} is not in this shop` };
  }
  const id = newId("sub");
  const ref = newId("ref", 20);
  const name = [pp.subscriber?.name?.given_name, pp.subscriber?.name?.surname].filter(Boolean).join(" ") || "Sandbox buyer";
  await db.query(
    "INSERT INTO subscribers (id, merchant_id, plan_id, home_plan_id, ref, paypal_subscription_id, status, subscriber_name, subscriber_email, channel, started_at) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'web',$9)",
    [id, m.id, plan.id, ref, paypalId, pp.status, name, pp.subscriber?.email_address ?? null, pp.start_time ? new Date(pp.start_time) : new Date()],
  );
  await paypalFor(m).setSubscriptionCustomId(paypalId, `${m.id}:${id}`);
  await db.query("INSERT INTO paypal_refs (resource_id, ws_id, merchant_id, kind) VALUES ($1,$2,$3,'subscription') ON CONFLICT (resource_id) DO UPDATE SET ws_id = EXCLUDED.ws_id, merchant_id = EXCLUDED.merchant_id", [paypalId, ws.id, m.id]);
  await logEvent(db, { merchantId: m.id, subscriberId: id, source: "system", type: "pool.claimed", summary: `Real sandbox subscription ${paypalId} joined this demo shop from the pre-approved pool (PayPal reads back ${pp.status})`, paypal: { id: pp.id, status: pp.status, plan_id: pp.plan_id } });
  // Copy PayPal's view (next billing, last payment) and its payment history into Kept, through the usual path.
  const svc = await import("../service.js");
  await svc.syncSubscription(ref, "system");
  return { ok: true, ref, note: `claimed ${paypalId}` };
}

/** Claims up to `want` ready items for a workspace. Each is re-read from PayPal before use. */
export async function claimForWorkspace(wsId: string, want = POOL_PER_WORKSPACE): Promise<{ claimed: string[]; notes: string[]; poolEmpty: boolean }> {
  const db = await getDb();
  const ws = await workspaceById(wsId, db);
  if (!ws) return { claimed: [], notes: ["no such workspace"], poolEmpty: false };
  const have = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_pool WHERE claimed_by_ws = $1 AND status = 'claimed'", [wsId])).rows[0]?.n ?? 0);
  const claimed: string[] = [];
  const notes: string[] = [];
  for (let i = have; i < want; i++) {
    const item = await db.tx(async (q) => {
      const it = (await q.query<PoolItem>("SELECT * FROM approval_pool WHERE status = 'ready' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!it) return null;
      await q.query("UPDATE approval_pool SET status = 'claimed', claimed_by_ws = $2, updated_at = now() WHERE id = $1", [it.id, wsId]);
      return it;
    });
    if (!item) break;
    try {
      const r = await adoptIntoWorkspace(ws, item.paypal_id);
      notes.push(r.note);
      if (r.ok) claimed.push(item.paypal_id);
      else i--; // that item was spent or unusable; try the next one
    } catch (e) {
      notes.push(`${item.paypal_id}: ${(e as Error).message.slice(0, 160)}`);
      await db.query("UPDATE approval_pool SET status = 'ready', claimed_by_ws = NULL, note = $2, updated_at = now() WHERE id = $1", [item.id, `claim failed: ${(e as Error).message.slice(0, 160)}`]);
      break;
    }
  }
  const total = have + claimed.length;
  const poolEmpty = total < want;
  const fresh = await workspaceById(wsId, db);
  if (fresh) {
    const checklist = { ...fresh.checklist, pool: { wanted: want, claimed: total, state: "done", empty: poolEmpty, notes: notes.slice(-5) } };
    await db.query("UPDATE workspaces SET checklist = $2 WHERE id = $1", [wsId, JSON.stringify(checklist)]);
  }
  return { claimed, notes, poolEmpty };
}
