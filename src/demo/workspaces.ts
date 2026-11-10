/**
 * Private demo workspaces (spec A1). Kept already has a tenant column (`merchant_id`), so a workspace is a new
 * merchants row cloned from the showcase shop: same PayPal product and plans (the same PayPal plan ids), the same
 * approved rules and owner limits, plus labelled sample history (`seed.ts`) and up to three real, pre-approved
 * sandbox subscriptions claimed from the approval pool (`pool.ts`).
 *
 * The showcase (`kind = 'showcase'`) is the shop the landing page reads. Visitors cannot sign in to it or
 * subscribe on it; it is rebuilt nightly through the same seeding path.
 */
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { getDb, type Queryable } from "../db.js";
import { sign, unsign } from "../lib/crypto.js";
import { newId, requestKey } from "../lib/ids.js";
import { paypalFor } from "../paypal/index.js";
import { KeptError, logEvent, merchantById, merchantBySlug, type Merchant } from "../store.js";
import { clearSamples, seedSamples, SEED_VERSION } from "./seed.js";

export const WS_COOKIE = "kept_ws";
export const IDLE_HOURS = 48;
export const MAX_LIVE = Number(process.env.KEPT_MAX_WORKSPACES || 300);
export const PER_IP_PER_HOUR = Number(process.env.KEPT_WORKSPACES_PER_IP_HOUR || 5);
export const POOL_PER_WORKSPACE = Number(process.env.KEPT_POOL_PER_WORKSPACE || 3);

export interface Workspace {
  id: string;
  tenant_id: string;
  kind: "visitor" | "showcase";
  ip_hash: string | null;
  seed_version: number;
  seed_state: "seeding" | "ready" | "failed";
  seed_error: string | null;
  checklist: Record<string, unknown>;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export const showcaseSlug = () => process.env.KEPT_DEMO_SHOP || "ember-oak-coffee-club";

export function ipHash(req: Request): string {
  // req.ip honours "trust proxy" (Render's one proxy hop), so a client cannot pick its own address by sending
  // its own X-Forwarded-For header.
  const ip = String(req.ip ?? req.socket.remoteAddress ?? "");
  return createHash("sha256").update(`${config.sessionSecret}|${ip}`).digest("hex").slice(0, 24);
}

const parse = (r: any): Workspace => ({ ...r, checklist: typeof r.checklist === "string" ? JSON.parse(r.checklist) : r.checklist ?? {} });

export async function workspaceById(id: string, q?: Queryable): Promise<Workspace | null> {
  const db = q ?? (await getDb());
  const r = (await db.query("SELECT * FROM workspaces WHERE id = $1", [id])).rows[0];
  return r ? parse(r) : null;
}

export async function workspaceOfTenant(merchantId: string, q?: Queryable): Promise<Workspace | null> {
  const db = q ?? (await getDb());
  const r = (await db.query("SELECT * FROM workspaces WHERE tenant_id = $1", [merchantId])).rows[0];
  return r ? parse(r) : null;
}

/** The visitor's own live workspace, from the signed cookie. */
export async function workspaceOf(req: Request): Promise<Workspace | null> {
  const id = unsign(req.cookies?.[WS_COOKIE]);
  if (!id) return null;
  const ws = await workspaceById(id);
  if (!ws || ws.kind !== "visitor" || new Date(ws.expires_at).getTime() < Date.now()) return null;
  return ws;
}

export function setWorkspaceCookie(res: Response, ws: Workspace) {
  res.cookie(WS_COOKIE, sign(ws.id), { httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https"), maxAge: IDLE_HOURS * 3600_000 * 7 });
}

/** A visitor's activity pushes expiry back to 48 hours from now (written at most every five minutes). */
export async function touch(ws: Workspace) {
  if (Date.now() - new Date(ws.last_seen_at).getTime() < 5 * 60_000) return;
  await (await getDb()).query(`UPDATE workspaces SET last_seen_at = now(), expires_at = now() + interval '${IDLE_HOURS} hours' WHERE id = $1`, [ws.id]);
}

export const joinToken = (ws: Workspace) => sign(`join-${ws.id}`);
export function workspaceIdFromJoin(token: string): string | null {
  const v = unsign(token);
  return v && v.startsWith("join-") ? v.slice(5) : null;
}

export async function showcase(q?: Queryable): Promise<Merchant> {
  const db = q ?? (await getDb());
  const m = await merchantBySlug(db, showcaseSlug());
  if (!m) throw new KeptError("The showcase shop does not exist yet. Run npm run seed to create it on the PayPal sandbox.", "not_found", 503);
  return m;
}

/** Marks the showcase shop as such (idempotent). */
export async function ensureShowcase(q?: Queryable): Promise<Workspace> {
  const db = q ?? (await getDb());
  const m = await showcase(db);
  await db.query(
    "INSERT INTO workspaces (id, tenant_id, kind, seed_state, expires_at) VALUES ($1,$2,'showcase','ready', now() + interval '100 years') ON CONFLICT (tenant_id) DO NOTHING",
    [newId("ws"), m.id],
  );
  return (await workspaceOfTenant(m.id, db))!;
}

export async function isShowcase(merchantId: string, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  return (await workspaceOfTenant(merchantId, db))?.kind === "showcase";
}

export async function isVisitorShop(merchantId: string, q?: Queryable): Promise<boolean> {
  return (await workspaceOfTenant(merchantId, q))?.kind === "visitor";
}

/** Copies the showcase shop's PayPal product, plans, approved rules and owner limits into a new shop row. */
async function cloneShowcase(q: Queryable, src: Merchant): Promise<Merchant> {
  const short = newId("x", 6).slice(2);
  const m: Merchant = { ...src, id: newId("mer"), slug: `${src.slug.split("-").slice(0, 2).join("-")}-${short}`, owner_token: newId("own", 24), owner_email: null, paypal_payer_id: null, created_at: new Date() } as Merchant;
  // Same PayPal app as the showcase, so the same webhook id verifies its events.
  await q.query(
    "INSERT INTO merchants (id, slug, name, tagline, currency, owner_email, paypal_payer_id, paypal_env, paypal_credentials, paypal_product_id, paypal_webhook_id, owner_token) VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,$7,$8,$9,$10)",
    [m.id, m.slug, src.name, src.tagline, src.currency, src.paypal_env, src.paypal_credentials, src.paypal_product_id, src.paypal_webhook_id ?? null, m.owner_token],
  );
  const plans = (await q.query<any>("SELECT * FROM plans WHERE merchant_id = $1 ORDER BY base_plan_id NULLS FIRST, created_at", [src.id])).rows;
  const ids = new Map<string, string>();
  for (const p of plans) ids.set(p.id, newId("plan"));
  for (const p of plans) {
    await q.query(
      "INSERT INTO plans (id, merchant_id, paypal_plan_id, name, description, kind, base_plan_id, discount_percent, price, interval_unit, interval_count, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [ids.get(p.id), m.id, p.paypal_plan_id, p.name, p.description, p.kind, p.base_plan_id ? ids.get(p.base_plan_id) ?? null : null, p.discount_percent, p.price, p.interval_unit, p.interval_count, p.active],
    );
  }
  const pol = (await q.query<any>("SELECT * FROM policies WHERE merchant_id = $1 AND approved_at IS NOT NULL ORDER BY version DESC LIMIT 1", [src.id])).rows[0];
  if (pol) {
    await q.query("INSERT INTO policies (id, merchant_id, version, rules, source_text, notes, approved_at) VALUES ($1,$2,1,$3,$4,$5,now())", [newId("pol"), m.id, typeof pol.rules === "string" ? pol.rules : JSON.stringify(pol.rules), pol.source_text, typeof pol.notes === "string" ? pol.notes : JSON.stringify(pol.notes ?? [])]);
  }
  await q.query(
    "INSERT INTO guard_settings (merchant_id, auto_discount_max_pct, auto_pause_max_cycles, approve_capture_above_cents) SELECT $1, auto_discount_max_pct, auto_pause_max_cycles, approve_capture_above_cents FROM guard_settings WHERE merchant_id = $2",
    [m.id, src.id],
  );
  await logEvent(q, { merchantId: m.id, source: "system", type: "workspace.created", summary: `Private demo copy of ${src.name}: the same PayPal sandbox plans and rules` });
  return m;
}

export interface StartResult {
  ws: Workspace;
  merchant: Merchant;
  reused: boolean;
}

/**
 * POST /demo/start. Rate limited per address; when every slot is taken the oldest idle workspace is wiped and
 * its slot reused. Sample rows are written before this returns (well under a second); pool claims, which call
 * PayPal, run after it in the background, and the page shows them arriving.
 */
export async function startWorkspace(ip: string, now = new Date()): Promise<StartResult> {
  const db = await getDb();
  const recent = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspaces WHERE kind = 'visitor' AND ip_hash = $1 AND created_at > now() - interval '1 hour'", [ip])).rows[0]?.n ?? 0);
  if (recent >= PER_IP_PER_HOUR) throw new KeptError(`You have started ${recent} demo shops in the last hour, the limit for one address. Use the one you have, or reset it from the demo page.`, "rate_limited", 429);
  const live = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspaces WHERE kind = 'visitor'")).rows[0]?.n ?? 0);
  let reused = false;
  if (live >= MAX_LIVE) {
    const oldest = (await db.query<{ id: string }>("SELECT id FROM workspaces WHERE kind = 'visitor' ORDER BY last_seen_at LIMIT 1")).rows[0];
    if (oldest) {
      await expireWorkspace(oldest.id, "reused: every demo slot was taken");
      reused = true;
    }
  }
  const src = await showcase(db);
  const wsId = newId("ws");
  const merchant = await db.tx(async (q) => {
    const m = await cloneShowcase(q, src);
    await q.query(`INSERT INTO workspaces (id, tenant_id, kind, ip_hash, seed_version, seed_state, created_at, last_seen_at, expires_at) VALUES ($1,$2,'visitor',$3,$4,'seeding',$5,$5,$5::timestamptz + interval '${IDLE_HOURS} hours')`, [wsId, m.id, ip, SEED_VERSION, now]);
    return m;
  });
  try {
    const seeded = await db.tx((q) => seedSamples(q, merchant, now));
    await db.query("UPDATE workspaces SET seed_state = 'ready', checklist = $2 WHERE id = $1", [wsId, JSON.stringify({ samples: seeded, pool: { wanted: POOL_PER_WORKSPACE, claimed: 0, state: "claiming" } })]);
  } catch (e) {
    await db.query("UPDATE workspaces SET seed_state = 'failed', seed_error = $2 WHERE id = $1", [wsId, (e as Error).message.slice(0, 300)]);
  }
  return { ws: (await workspaceById(wsId))!, merchant, reused };
}

/** Every table that holds a shop's rows, children first. The audit chain is append-only and keeps its rows. */
async function deleteTenantRows(q: Queryable, merchantId: string) {
  const subs = "SELECT id FROM subscribers WHERE merchant_id = $1";
  await q.query(`DELETE FROM jobs WHERE status IN ('pending','failed') AND (payload->>'subscriberId' IN (${subs}) OR payload->>'offerId' IN (SELECT id FROM offers WHERE merchant_id = $1))`, [merchantId]);
  await q.query(`DELETE FROM channel_messages WHERE (entity = 'subscriber' AND entity_id IN (${subs})) OR (entity = 'merchant' AND entity_id = $1)`, [merchantId]);
  await q.query(`DELETE FROM party_links WHERE (party = 'subscriber' AND party_id IN (${subs})) OR (party = 'owner' AND party_id = $1)`, [merchantId]);
  await q.query(`DELETE FROM push_subscriptions WHERE (party = 'subscriber' AND party_id IN (${subs})) OR (party = 'owner' AND party_id = $1)`, [merchantId]);
  await q.query(`DELETE FROM settings WHERE key LIKE '%' || $1 || '%'`, [merchantId]);
  await q.query("DELETE FROM agent_trace WHERE run_id IN (SELECT id FROM agent_runs WHERE merchant_id = $1)", [merchantId]);
  for (const t of ["agent_runs", "offers", "feedback", "payments", "invoices", "event_log", "agent_requests", "approvals", "guard_settings", "judge_sessions", "paypal_refs"]) {
    await q.query(`DELETE FROM ${t} WHERE merchant_id = $1`, [merchantId]);
  }
  await q.query("DELETE FROM subscribers WHERE merchant_id = $1", [merchantId]);
  await q.query("DELETE FROM policies WHERE merchant_id = $1", [merchantId]);
  await q.query("DELETE FROM plans WHERE merchant_id = $1", [merchantId]);
  await q.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
}

export interface ExpireResult {
  workspace: string;
  cancelled: { paypalId: string; status: string }[];
  kept: { paypalId: string; movedTo: string }[];
  failed: { paypalId: string; error: string }[];
}

/**
 * Idle expiry (and the admin's forced expiry). Each real subscription the workspace holds is cancelled at PayPal
 * and read back, unless `moveTo` names a workspace that takes it over (the visitor's own reset).
 */
export async function expireWorkspace(wsId: string, why: string, moveTo?: Workspace): Promise<ExpireResult> {
  const db = await getDb();
  const ws = await workspaceById(wsId, db);
  if (!ws) throw new KeptError("No such workspace.", "not_found", 404);
  if (ws.kind !== "visitor") throw new KeptError("The showcase is rebuilt, never expired.", "not_allowed", 409);
  const m = await merchantById(db, ws.tenant_id);
  const out: ExpireResult = { workspace: wsId, cancelled: [], kept: [], failed: [] };
  if (m) {
    const real = (await db.query<any>("SELECT * FROM subscribers WHERE merchant_id = $1 AND NOT is_sample AND paypal_subscription_id IS NOT NULL", [m.id])).rows;
    const { adoptIntoWorkspace } = await import("./pool.js");
    for (const s of real) {
      const ppId: string = s.paypal_subscription_id;
      try {
        if (moveTo && ["ACTIVE", "SUSPENDED"].includes(s.status)) {
          await db.query("UPDATE subscribers SET paypal_subscription_id = NULL WHERE id = $1", [s.id]);
          await db.query("INSERT INTO approval_pool (id, paypal_id, status, claimed_by_ws, note) VALUES ($1,$2,'claimed',$3,'moved on reset') ON CONFLICT (paypal_id) DO UPDATE SET status = 'claimed', claimed_by_ws = EXCLUDED.claimed_by_ws, updated_at = now()", [newId("pool"), ppId, moveTo.id]);
          await adoptIntoWorkspace(moveTo, ppId);
          out.kept.push({ paypalId: ppId, movedTo: moveTo.id });
          continue;
        }
        const pp = paypalFor(m);
        const before = await pp.getSubscription(ppId);
        if (!["CANCELLED", "EXPIRED"].includes(before.status)) await pp.cancelSubscription(ppId, "Demo workspace expired", requestKey("ws-expire", ws.id, ppId));
        const after = await pp.getSubscription(ppId);
        out.cancelled.push({ paypalId: ppId, status: after.status });
        await db.query("UPDATE approval_pool SET status = 'spent', note = $2, updated_at = now() WHERE paypal_id = $1", [ppId, `cancelled when ${ws.id} expired (read back ${after.status})`]);
      } catch (e) {
        out.failed.push({ paypalId: ppId, error: (e as Error).message.slice(0, 200) });
      }
    }
    await db.tx((q) => deleteTenantRows(q, m.id));
  }
  await db.query("DELETE FROM workspaces WHERE id = $1", [wsId]);
  await logEvent(db, { source: "system", type: "workspace.expired", summary: `Workspace ${wsId} removed (${why}): ${out.cancelled.length} cancelled at PayPal, ${out.kept.length} moved, ${out.failed.length} failed`, payload: out });
  return out;
}

/** "Reset my demo": a fresh copy for this visitor only; the real subscriptions it holds move to the new copy. */
export async function resetWorkspace(old: Workspace, ip: string): Promise<StartResult> {
  const db = await getDb();
  // A reset is not a new visitor, so it does not count against the hourly limit.
  await db.query("UPDATE workspaces SET created_at = created_at - interval '2 hours' WHERE id = $1", [old.id]);
  const next = await startWorkspace(ip);
  await expireWorkspace(old.id, "reset by the visitor", next.ws);
  return next;
}

/** Idle workspaces past their expiry. Run by the worker's slow loop. */
export async function expireIdle(now = new Date()): Promise<ExpireResult[]> {
  const db = await getDb();
  const due = (await db.query<{ id: string }>("SELECT id FROM workspaces WHERE kind = 'visitor' AND expires_at < $1 ORDER BY expires_at LIMIT 20", [now])).rows;
  const out: ExpireResult[] = [];
  for (const d of due) out.push(await expireWorkspace(d.id, `idle for ${IDLE_HOURS} hours`));
  return out;
}

/**
 * Nightly showcase rebuild through the same seeding path. Live subscriptions still sitting in the showcase (from
 * before workspaces existed) move into the approval pool, finished test residue is removed, and the sample
 * history is written again with today's relative dates.
 */
export async function rebuildShowcase(now = new Date()) {
  const db = await getDb();
  const ws = await ensureShowcase(db);
  const m = (await merchantById(db, ws.tenant_id))!;
  const real = (await db.query<any>("SELECT id, ref, status, paypal_subscription_id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample", [m.id])).rows;
  const pooled: string[] = [];
  const removed: string[] = [];
  for (const s of real) {
    if (s.paypal_subscription_id && ["ACTIVE", "SUSPENDED"].includes(s.status)) {
      await db.query("INSERT INTO approval_pool (id, paypal_id, status, note) VALUES ($1,$2,'ready','moved from the showcase shop') ON CONFLICT (paypal_id) DO NOTHING", [newId("pool"), s.paypal_subscription_id]);
      pooled.push(s.paypal_subscription_id);
    }
    removed.push(s.ref);
  }
  await db.tx(async (q) => {
    if (real.length) {
      const ids = real.map((s) => s.id);
      await q.query("DELETE FROM jobs WHERE status IN ('pending','failed') AND payload->>'subscriberId' = ANY($1)", [ids]);
      await q.query("DELETE FROM channel_messages WHERE entity = 'subscriber' AND entity_id = ANY($1)", [ids]);
      await q.query("DELETE FROM party_links WHERE party = 'subscriber' AND party_id = ANY($1)", [ids]);
      await q.query("DELETE FROM push_subscriptions WHERE party = 'subscriber' AND party_id = ANY($1)", [ids]);
      for (const t of ["offers", "feedback", "payments", "invoices", "event_log"]) await q.query(`DELETE FROM ${t} WHERE subscriber_id = ANY($1)`, [ids]);
      await q.query("DELETE FROM agent_trace WHERE run_id IN (SELECT id FROM agent_runs WHERE entity = 'subscriber' AND entity_id = ANY($1))", [ids]);
      await q.query("DELETE FROM agent_runs WHERE entity = 'subscriber' AND entity_id = ANY($1)", [ids]);
      await q.query("DELETE FROM subscribers WHERE id = ANY($1)", [ids]);
    }
    await clearSamples(q, m.id);
    await seedSamples(q, m, now);
  });
  await db.query("UPDATE workspaces SET seed_version = $2, seed_state = 'ready', last_seen_at = now(), checklist = $3 WHERE id = $1", [ws.id, SEED_VERSION, JSON.stringify({ rebuiltAt: now.toISOString(), pooled, removed: removed.length })]);
  await logEvent(db, { merchantId: m.id, source: "system", type: "showcase.rebuilt", summary: `Showcase rebuilt: samples rewritten, ${pooled.length} live subscription(s) moved to the approval pool, ${removed.length} non-sample row(s) removed` });
  return { pooled, removed };
}
