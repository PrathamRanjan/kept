/**
 * Demo workspace routes (spec A1.2, A2.2): start, status, join on a second device, reset, pool claims, and the
 * admin pages for the pool and the live workspaces. The owner cookie is the same signed `kept_owner` every owner
 * page reads, set to the visitor's own shop; the visitor never signs in to the shared showcase.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import QRCode from "qrcode";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { sign } from "../lib/crypto.js";
import { claimForWorkspace, listPool, poolCounts, refillPool, syncPool } from "../demo/pool.js";
import { ensureShowcase, expireWorkspace, ipHash, joinToken, rebuildShowcase, resetWorkspace, setWorkspaceCookie, startWorkspace, touch, workspaceById, workspaceIdFromJoin, workspaceOf, WS_COOKIE, IDLE_HOURS, POOL_PER_WORKSPACE, type Workspace } from "../demo/workspaces.js";
import { KeptError, merchantById, type Merchant } from "../store.js";
import { addAdminSection, adminBack, isAdmin } from "./admin.js";
import { runNightly } from "../eval/nightly.js";
import { html, layout } from "./html.js";

type H = (req: Request, res: Response) => Promise<unknown>;
const page = (fn: H) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const j = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res)
    .then((out) => { if (!res.headersSent) res.json(out); })
    .catch((e) => {
      const status = e instanceof KeptError ? e.status : 500;
      res.status(status).json({ error: e instanceof KeptError ? e.code : "error", message: (e as Error).message });
    });

/** Pool claims run after /demo/start returns; tests and the status endpoint can wait on them. */
const claiming = new Map<string, Promise<unknown>>();
export async function waitForClaims() {
  await Promise.allSettled([...claiming.values()]);
}
function claimInBackground(wsId: string) {
  const p = claimForWorkspace(wsId)
    .catch(async (e) => {
      const ws = await workspaceById(wsId);
      if (ws) await (await getDb()).query("UPDATE workspaces SET checklist = $2 WHERE id = $1", [wsId, JSON.stringify({ ...ws.checklist, pool: { wanted: POOL_PER_WORKSPACE, claimed: 0, state: "failed", error: (e as Error).message.slice(0, 200) } })]);
    })
    .finally(() => claiming.delete(wsId));
  claiming.set(wsId, p);
}

export function setOwnerCookie(res: Response, m: Merchant) {
  res.cookie("kept_owner", sign(m.id), { httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https"), maxAge: 30 * 864e5 });
}

/** The visitor's workspace, creating one when they have none. Used by every "demo owner" button. */
export async function ensureWorkspace(req: Request, res: Response): Promise<{ ws: Workspace; merchant: Merchant; created: boolean }> {
  const have = await workspaceOf(req);
  if (have) {
    const m = await merchantById(await getDb(), have.tenant_id);
    if (m) {
      setOwnerCookie(res, m);
      return { ws: have, merchant: m, created: false };
    }
  }
  const out = await startWorkspace(ipHash(req));
  setWorkspaceCookie(res, out.ws);
  setOwnerCookie(res, out.merchant);
  claimInBackground(out.ws.id);
  return { ws: out.ws, merchant: out.merchant, created: true };
}

/** What the demo page shows about the visitor's own workspace. Every number is read from the database. */
export async function workspaceStatus(ws: Workspace, req?: Request) {
  const db = await getDb();
  const m = await merchantById(db, ws.tenant_id);
  if (!m) return null;
  const counts = (await db.query<{ samples: number; real: number; real_active: number }>(
    "SELECT count(*) FILTER (WHERE is_sample)::int AS samples, count(*) FILTER (WHERE NOT is_sample)::int AS real, count(*) FILTER (WHERE NOT is_sample AND status IN ('ACTIVE','SUSPENDED'))::int AS real_active FROM subscribers WHERE merchant_id = $1",
    [m.id],
  )).rows[0];
  const member = (await db.query<{ ref: string; is_sample: boolean }>("SELECT ref, is_sample FROM subscribers WHERE merchant_id = $1 AND status IN ('ACTIVE','SUSPENDED') ORDER BY is_sample, created_at DESC LIMIT 1", [m.id])).rows[0];
  const pool = (ws.checklist as any)?.pool ?? { wanted: POOL_PER_WORKSPACE, claimed: 0, state: "claiming" };
  const pc = await poolCounts();
  const realLine =
    pool.state === "claiming"
      ? "Claiming real sandbox subscriptions from the pre-approved pool…"
      : counts.real_active > 0
        ? `${counts.real_active} of ${pool.wanted} real PayPal sandbox subscriptions are in your shop, read back from PayPal.`
        : `No real PayPal subscription is in your shop yet: the pre-approved pool is empty (${pc.awaiting} waiting for the sandbox buyer's approval). Subscribe on PayPal's own page from your shop with the sandbox buyer shown on the judge page.`;
  const joinUrl = `${config.appUrl}/demo/join/${joinToken(ws)}`;
  return {
    workspace: { id: ws.id, kind: ws.kind, seedState: ws.seed_state, seedError: ws.seed_error, createdAt: ws.created_at, lastSeenAt: ws.last_seen_at, expiresAt: ws.expires_at, idleHours: IDLE_HOURS },
    shop: { name: m.name, slug: m.slug, url: `/s/${m.slug}` },
    counts: { samples: counts.samples, real: counts.real, realActive: counts.real_active },
    sampleNote: counts.samples ? `This shop holds ${counts.samples} sample members. No PayPal money moved for them; each one is marked as a sample here and in the records, and none is counted in a "confirmed by PayPal" figure.` : null,
    pool: { wanted: pool.wanted, claimed: pool.claimed ?? 0, state: pool.state, line: realLine, poolReady: pc.ready },
    memberRef: member?.ref ?? null,
    memberIsSample: member?.is_sample ?? null,
    joinUrl,
    joinQr: req ? await QRCode.toString(joinUrl, { type: "svg", margin: 1, width: 168 }) : null,
  };
}

export function demoRouter(): Router {
  const r = Router();

  // Activity in a workspace pushes its expiry back.
  r.use(async (req, _res, next) => {
    if (req.cookies?.[WS_COOKIE]) {
      try {
        const ws = await workspaceOf(req);
        if (ws) await touch(ws);
      } catch {
        /* a failed touch never blocks a page */
      }
    }
    next();
  });

  r.post("/demo/start", j(async (req, res) => {
    if (!config.demoMode) throw new KeptError("Demo mode is off.", "not_allowed", 403);
    const out = await ensureWorkspace(req, res);
    const status = await workspaceStatus(out.ws, req);
    if (!req.accepts("json") || req.is("application/x-www-form-urlencoded")) return res.redirect("/demo");
    return { ok: true, created: out.created, ...status };
  }));

  r.get("/demo/status", j(async (req) => {
    const ws = await workspaceOf(req);
    if (!ws) return { workspace: null, start: "POST /demo/start", poolReady: (await poolCounts()).ready };
    return workspaceStatus(ws, req);
  }));

  r.get("/demo/join/:token", page(async (req, res) => {
    const id = workspaceIdFromJoin(req.params.token);
    const ws = id ? await workspaceById(id) : null;
    if (!ws || ws.kind !== "visitor" || new Date(ws.expires_at).getTime() < Date.now()) {
      return res.status(404).send(layout({ title: "Demo link expired" }, html`<h1>That demo link has expired</h1><p>The demo shop it opened was reset or removed after ${IDLE_HOURS} idle hours. <a href="/demo">Start a new demo</a>.</p>`));
    }
    const m = await merchantById(await getDb(), ws.tenant_id);
    if (!m) return res.redirect("/demo");
    setWorkspaceCookie(res, ws);
    setOwnerCookie(res, m);
    const st = await workspaceStatus(ws);
    res.redirect(req.query.to === "member" && st?.memberRef ? `/manage/${st.memberRef}` : "/demo?joined=1");
  }));

  r.post("/demo/reset", j(async (req, res) => {
    const ws = await workspaceOf(req);
    if (!ws) throw new KeptError("You have no demo shop to reset. Start one first.", "not_found", 404);
    const out = await resetWorkspace(ws, ipHash(req));
    setWorkspaceCookie(res, out.ws);
    setOwnerCookie(res, out.merchant);
    // Real subscriptions moved across with the reset; top up from the pool if fewer than three came.
    claimInBackground(out.ws.id);
    if (!req.accepts("json") || req.is("application/x-www-form-urlencoded")) return res.redirect("/demo?reset=1");
    return { ok: true, ...(await workspaceStatus(out.ws, req)) };
  }));

  r.post("/demo/pool/claim", j(async (req) => {
    const ws = await workspaceOf(req);
    if (!ws) throw new KeptError("Start a demo shop first.", "not_found", 404);
    const out = await claimForWorkspace(ws.id);
    return { ...out, message: out.poolEmpty ? "The pre-approved pool is empty; approve on PayPal with the sandbox account shown." : `Claimed ${out.claimed.length}.` };
  }));

  /** Where PayPal returns the owner after approving a pool subscription. */
  r.get("/demo/pool/approved", page(async (req, res) => {
    const out = await syncPool().catch(() => null);
    res.send(layout({ title: "Pool subscription approved" }, html`<h1>${req.query.cancelled ? "Not approved" : "Thank you"}</h1>
<p>${req.query.cancelled ? "PayPal returned without an approval; the subscription stays in the pool as waiting." : "PayPal has the approval. Kept read the pool back from PayPal"}${out ? `: ${out.ready} ready, ${out.spent} spent.` : "."}</p>
<p><a href="${isAdmin(req) ? "/admin/pool" : "/demo"}">Back</a></p>`));
  }));

  /* ---------------- admin: pool and workspaces ---------------- */
  const guard = (req: Request, res: Response) => {
    if (isAdmin(req)) return true;
    res.status(401).json({ error: "unauthorized", message: "Admin key required." });
    return false;
  };

  r.get("/admin/pool", page(async (req, res) => {
    if (!isAdmin(req)) return res.redirect(`/admin?next=${encodeURIComponent("/admin/pool")}`);
    const items = await listPool(200);
    const c = await poolCounts();
    res.send(layout({ title: "Approval pool" }, html`<h1>Approval pool</h1>
${typeof req.query.ok === "string" ? html`<div class="banner good" role="status">${req.query.ok}</div>` : ""}${typeof req.query.err === "string" ? html`<div class="banner bad" role="alert">${req.query.err}</div>` : ""}
<p class="muted">Pre-approved PayPal sandbox subscriptions for demo workspaces. ${c.ready} ready · ${c.awaiting} waiting for approval · ${c.claimed} claimed · ${c.spent} spent.${c.ready < 10 ? " Fewer than 10 ready: create and approve more." : ""}</p>
<div class="card"><h2>Create subscriptions to approve</h2><p>Each one needs the sandbox buyer's approval on PayPal's page. Open each link while signed in to the sandbox buyer, or run <code>node scripts/sandbox-approver.mjs</code> in your own shell with the buyer's email and password in environment variables.</p>
<form method="post" action="/admin/pool/refill" class="row"><label for="n">How many</label><input id="n" name="n" type="number" min="1" max="25" value="5"><button class="btn primary" type="submit">Create</button></form>
<form method="post" action="/admin/pool/sync" class="row" style="margin-top:8px"><button class="btn" type="submit">Read the pool back from PayPal</button></form>
<form method="post" action="/admin/showcase/rebuild" class="row" style="margin-top:8px"><button class="btn" type="submit">Rebuild the showcase now</button></form></div>
<div class="table-wrap"><table><tr><th>PayPal id</th><th>Status</th><th>Workspace</th><th>Note</th><th>Approve</th></tr>
${items.map((i) => html`<tr><td><code>${i.paypal_id}</code></td><td>${i.status}</td><td>${i.claimed_by_ws ?? ""}</td><td class="small">${i.note ?? ""}</td><td>${i.status === "awaiting_approval" && i.approve_url ? html`<a href="${i.approve_url}" rel="noopener" target="_blank">Approve on PayPal</a>` : ""}</td></tr>`)}</table></div>
<p><a href="/admin">Back to admin</a></p>`));
  }));
  r.get("/admin/pool.json", j(async (req, res) => {
    if (!guard(req, res)) return;
    return { counts: await poolCounts(), items: (await listPool(200)).map((i) => ({ ...i, approve_url: i.status === "awaiting_approval" ? i.approve_url : null })) };
  }));
  r.post("/admin/pool/refill", page(async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send("Admin key required.");
    try {
      const out = await refillPool(Number(req.body?.n ?? 5));
      if (req.accepts(["html", "json"]) === "json") return res.json({ plan: out.plan, created: out.created.map((i) => ({ id: i.id, paypal_id: i.paypal_id, approve_url: i.approve_url })) });
      adminBack(res, "/admin/pool", `Created ${out.created.length} on ${out.plan}. Approve each on PayPal.`);
    } catch (e) {
      adminBack(res, "/admin/pool", (e as Error).message, true);
    }
  }));
  r.post("/admin/pool/sync", page(async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send("Admin key required.");
    const out = await syncPool();
    if (req.accepts(["html", "json"]) === "json") return res.json(out);
    adminBack(res, "/admin/pool", `Checked ${out.checked}: ${out.ready} ready, ${out.spent} spent, ${out.errors} errors.`);
  }));
  r.post("/admin/showcase/rebuild", page(async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send("Admin key required.");
    const out = await rebuildShowcase();
    if (req.accepts(["html", "json"]) === "json") return res.json(out);
    adminBack(res, "/admin/pool", `Showcase rebuilt: ${out.pooled.length} live subscription(s) moved to the pool, ${out.removed.length} non-sample row(s) removed.`);
  }));
  r.post("/admin/showcase/rotate-token", page(async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send("Admin key required.");
    const db = await getDb();
    const ws = await ensureShowcase(db);
    const { newId } = await import("../lib/ids.js");
    await db.query("UPDATE merchants SET owner_token = $2 WHERE id = $1", [ws.tenant_id, newId("own", 24)]);
    adminBack(res, "/admin/workspaces", "The showcase's owner key was replaced. The old key no longer signs in.");
  }));

  r.get("/admin/workspaces", page(async (req, res) => {
    if (!isAdmin(req)) return res.redirect(`/admin?next=${encodeURIComponent("/admin/workspaces")}`);
    const rows = (await (await getDb()).query<any>("SELECT w.*, m.slug, (SELECT count(*)::int FROM subscribers s WHERE s.merchant_id = w.tenant_id AND NOT s.is_sample) AS real FROM workspaces w LEFT JOIN merchants m ON m.id = w.tenant_id ORDER BY w.kind DESC, w.last_seen_at DESC LIMIT 300")).rows;
    res.send(layout({ title: "Demo workspaces" }, html`<h1>Demo workspaces</h1>
${typeof req.query.ok === "string" ? html`<div class="banner good" role="status">${req.query.ok}</div>` : ""}
<p class="muted">${rows.filter((r) => r.kind === "visitor").length} visitor workspaces. Each expires ${IDLE_HOURS} hours after its last visit.</p>
<form method="post" action="/admin/showcase/rotate-token"><button class="btn" type="submit">Replace the showcase's owner key</button></form>
<div class="table-wrap"><table><tr><th>Id</th><th>Kind</th><th>Shop</th><th>Real members</th><th>Last seen</th><th>Expires</th><th></th></tr>
${rows.map((w) => html`<tr><td><code>${w.id}</code></td><td>${w.kind}</td><td>${w.slug ?? ""}</td><td>${w.real}</td><td>${new Date(w.last_seen_at).toISOString().slice(0, 16)}</td><td>${w.kind === "visitor" ? new Date(w.expires_at).toISOString().slice(0, 16) : "never"}</td><td>${w.kind === "visitor" ? html`<form method="post" action="/admin/workspaces/${w.id}/expire" class="inline"><button class="btn small" type="submit">Expire now</button></form>` : ""}</td></tr>`)}</table></div>
<p><a href="/admin">Back to admin</a></p>`));
  }));
  r.get("/admin/workspaces.json", j(async (req, res) => {
    if (!guard(req, res)) return;
    return { workspaces: (await (await getDb()).query("SELECT id, tenant_id, kind, seed_state, created_at, last_seen_at, expires_at FROM workspaces ORDER BY created_at DESC LIMIT 300")).rows };
  }));
  r.post("/admin/workspaces/:id/expire", j(async (req, res) => {
    if (!guard(req, res)) return;
    const out = await expireWorkspace(req.params.id, "expired by the admin");
    if (req.accepts(["html", "json"]) === "html") return res.redirect(`/admin/workspaces?ok=${encodeURIComponent(`Expired ${out.workspace}: ${out.cancelled.length} cancelled at PayPal, ${out.failed.length} failed.`)}`);
    return out;
  }));
  // A5.6: run the daily showcase set now (real model calls; nothing moves money).
  r.post("/admin/showcase/eval", j(async (req, res) => {
    if (!guard(req, res)) return;
    return await runNightly("admin");
  }));

  return r;
}

addAdminSection(async () => {
  const c = await poolCounts();
  const n = Number((await (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM workspaces WHERE kind = 'visitor'")).rows[0]?.n ?? 0);
  return html`<div class="card"><h2>Demo workspaces and the approval pool</h2><p>${n} visitor workspaces live. Pool: ${c.ready} ready, ${c.awaiting} waiting for approval, ${c.claimed} claimed, ${c.spent} spent.</p><p><a href="/admin/pool">Approval pool</a> · <a href="/admin/workspaces">Workspaces</a></p></div>`;
});
