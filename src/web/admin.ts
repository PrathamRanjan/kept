/**
 * Admin pages (KEPT_ADMIN_KEY). Never linked for visitors. The saved demo wallet (A2.1), the approval pool (A2.2),
 * workspaces and the showcase shop (A1) are managed here. Sign in with the key once (signed http-only cookie), or
 * send it as `Authorization: Bearer <key>` for scripts.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { sign, unsign } from "../lib/crypto.js";
import { checkWallet, finishWalletApproval, lastWalletHealth, startWalletApproval, walletToken, mask } from "../demo/wallet.js";
import { esc, html, layout, raw, type Raw } from "./html.js";

const COOKIE = "kept_admin";
type H = (req: Request, res: Response) => Promise<unknown>;
const page = (fn: H) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function keyMatches(k: string): boolean {
  if (!config.adminKey || !k) return false;
  const a = Buffer.from(k);
  const b = Buffer.from(config.adminKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAdmin(req: Request): boolean {
  if (!config.adminKey) return false;
  const bearer = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer && keyMatches(bearer)) return true;
  return unsign(req.cookies?.[COOKIE]) === "admin";
}

function requireAdmin(req: Request, res: Response): boolean {
  if (isAdmin(req)) return true;
  if (req.accepts("html")) res.status(401).send(layout({ title: "Admin sign-in" }, loginForm(req.originalUrl)));
  else res.status(401).json({ error: "unauthorized", message: "Admin key required." });
  return false;
}

const loginForm = (next: string): Raw => html`<h1>Admin</h1>
<p class="muted">${config.adminKey ? "Sign in with the admin key." : "KEPT_ADMIN_KEY is not set on this server, so admin pages are off."}</p>
${config.adminKey ? html`<form method="post" action="/admin/login" class="stack" style="max-width:420px"><input type="hidden" name="next" value="${next}"><label for="key">Admin key</label><input id="key" name="key" type="password" autocomplete="off" required><button class="btn primary" type="submit">Sign in</button></form>` : ""}`;

const flash = (req: Request): Raw => {
  const msg = typeof req.query.ok === "string" ? req.query.ok : typeof req.query.err === "string" ? req.query.err : "";
  return msg ? html`<div class="banner ${req.query.err ? "bad" : "good"}" role="status">${msg}</div>` : raw("");
};
export const adminBack = (res: Response, url: string, msg: string, isErr = false) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${isErr ? "err" : "ok"}=${encodeURIComponent(msg)}`);

/** Extra admin sections registered by other modules (pool, workspaces) so this file stays small. */
const sections: ((req: Request) => Promise<Raw>)[] = [];
export function addAdminSection(fn: (req: Request) => Promise<Raw>) {
  sections.push(fn);
}

export function adminRouter(): Router {
  const r = Router();

  r.post("/admin/login", (req, res) => {
    const next = String(req.body?.next ?? "/admin");
    if (!keyMatches(String(req.body?.key ?? ""))) return res.status(401).send(layout({ title: "Admin sign-in" }, html`<div class="banner bad" role="alert">That key is not right.</div>${loginForm(next)}`));
    res.cookie(COOKIE, sign("admin"), { httpOnly: true, sameSite: "strict", secure: config.appUrl.startsWith("https"), maxAge: 12 * 3600_000 });
    res.redirect(/^\/admin(\/|$)/.test(next) ? next : "/admin");
  });
  r.post("/admin/logout", (_req, res) => {
    res.clearCookie(COOKIE);
    res.redirect("/");
  });

  r.get("/admin", page(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const extra = await Promise.all(sections.map((s) => s(req)));
    res.send(layout({ title: "Admin" }, html`<h1>Admin</h1>${flash(req)}
<p class="muted">Not linked anywhere a visitor can see. <a href="/admin/paypal/wallet">Saved demo wallet</a></p>
${extra}
<form method="post" action="/admin/logout"><button class="btn" type="submit">Sign out of admin</button></form>`));
  }));

  r.get("/admin/paypal/wallet", page(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const w = await walletToken();
    const h = (await lastWalletHealth()) ?? null;
    res.send(layout({ title: "Saved demo wallet" }, html`<h1>Saved demo wallet</h1>${flash(req)}
<p class="muted">One sandbox buyer's PayPal, saved with Vault v3 for merchant use. Token in use: <b>${w.token ? mask(w.token) : "none"}</b> (from ${w.source === "admin" ? "a re-approval on this page" : w.source === "setting" ? "the PAYPAL_DEMO_VAULT_TOKEN setting" : "nowhere"}).</p>
<div class="card"><h2>Health</h2>${h ? html`<p><b>${h.ok ? "Healthy" : "Needs attention"}</b>: ${h.detail}</p><p class="small muted">Checked ${h.checkedAt}${h.buyerEmail ? html` · buyer ${h.buyerEmail}` : ""}</p>` : html`<p>Not checked yet.</p>`}
<form method="post" action="/admin/paypal/wallet/check"><button class="btn" type="submit">Check with PayPal now</button></form></div>
<div class="card"><h2>What Kept uses it for</h2><p>PayPal Subscriptions need the buyer's approval for each subscription, even with a saved wallet (probed 10 Nov 2026: a subscription created with the vaulted wallet still came back APPROVAL_PENDING). So Kept's real demo members come from the approval pool, not from this wallet. The wallet is checked daily so the other demo steps that can use it stay healthy.</p></div>
<div class="card"><h2>Re-approve</h2><p>Only if PayPal has removed the token. You approve on PayPal's page as the sandbox buyer; Kept then reads the new token back before saving it.</p>
<form method="post" action="/admin/paypal/wallet/start"><button class="btn primary" type="submit">Start re-approval on PayPal</button></form></div>
<p><a href="/admin">Back to admin</a></p>`));
  }));

  r.post("/admin/paypal/wallet/check", page(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const h = await checkWallet();
    adminBack(res, "/admin/paypal/wallet", h.ok ? "PayPal has the saved wallet." : h.detail, !h.ok);
  }));
  r.post("/admin/paypal/wallet/start", page(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.redirect(await startWalletApproval());
    } catch (e) {
      adminBack(res, "/admin/paypal/wallet", (e as Error).message, true);
    }
  }));
  r.get("/admin/paypal/wallet/return", page(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = String(req.query.approval_token_id ?? req.query.token ?? "");
    try {
      const h = await finishWalletApproval(id);
      adminBack(res, "/admin/paypal/wallet", h.ok ? "Saved and read back from PayPal." : h.detail, !h.ok);
    } catch (e) {
      adminBack(res, "/admin/paypal/wallet", (e as Error).message, true);
    }
  }));

  /** For scripts and the acceptance check: the wallet health as JSON (token masked). */
  r.get("/admin/paypal/wallet.json", page(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(String(req.query.check) === "1" ? await checkWallet() : (await lastWalletHealth()) ?? { ok: false, detail: "not checked yet" });
  }));

  return r;
}

export { esc };
