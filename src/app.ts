import compression from "compression";
import { publicRouter } from "./web/public.js";
import express from "express";
import cookieParser from "cookie-parser";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter } from "./api.js";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { agentIdOf, serveMcp } from "./mcp/http.js";
import { buildBuyerServer, buildOwnerServer } from "./mcp/tools.js";
import { merchantBySlug, merchantByToken } from "./store.js";
import { receiveWebhook } from "./webhooks.js";
import { webRouter } from "./web/routes.js";
import { guardRouter } from "./web/guard.js";
import { safetyRouter } from "./web/safety.js";
import { foundationRouter, runsApi } from "./web/foundation.js";
import { installChannelHandlers } from "./channels/handlers.js";
import { uiApi } from "./web/ui-api.js";
import { spaRouter } from "./web/spa.js";
import { adminRouter } from "./web/admin.js";
import { demoRouter } from "./web/demo.js";
import { KeptError } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export function createApp() {
  const app = express();
  // gzip pages, assets and JSON; never streams (MCP and server-sent events must flush as they go).
  app.use(compression({ filter: (req, res) => !/\/mcp$|\/events?$|\/stream/.test(req.path) && !/event-stream/.test(String(res.getHeader("Content-Type") ?? "")) && compression.filter(req, res) }));
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "200kb" }));
  app.use(express.urlencoded({ extended: false, limit: "200kb" }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // PayPal's button frames ask for the Payment Request feature; delegate it to PayPal only.
    res.setHeader("Permissions-Policy", 'payment=(self "https://www.paypal.com" "https://www.sandbox.paypal.com"), camera=(), geolocation=()');
    next();
  });
  // Spec B5 (5): the cancel widget any shop can embed. Cross-origin by design; it reads nothing and sets nothing.
  app.get("/widget.js", (_req, res) => res.set({ "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "cross-origin-resource-policy": "cross-origin", "access-control-allow-origin": "*" }).sendFile(join(root, "public", "widget.js")));
  app.use("/static", express.static(join(root, "public"), { maxAge: 0, setHeaders: (res, file) => { if (/[\\/]safety[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=86400"); } }));

  // Server timing on every API and page response, so slow first paint can be measured from the browser.
  app.use((req, res, next) => {
    const t0 = process.hrtime.bigint();
    const write = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: any[]) {
      if (!res.headersSent) res.setHeader("Server-Timing", `app;dur=${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}`);
      return (write as any).apply(this, args);
    } as any;
    next();
  });

  /** Health: the database answers, and which commit this build runs. Used by the keep-warm job and Render. */
  app.get("/healthz", async (_req, res) => {
    const t0 = Date.now();
    res.setHeader("Cache-Control", "no-store");
    try {
      const db = await getDb();
      const r = (await db.query<{ now: Date }>("SELECT now() AS now")).rows[0];
      res.json({ ok: true, db: { ok: true, kind: db.kind, ms: Date.now() - t0, now: r.now }, commit: config.commit || null, uptimeSec: Math.round(process.uptime()) });
    } catch (e) {
      res.status(503).json({ ok: false, db: { ok: false, error: (e as Error).message.slice(0, 200) }, commit: config.commit || null });
    }
  });

  app.get("/openapi.yaml", (_req, res) => res.type("text/yaml").send(readFileSync(join(root, "docs", "openapi.yaml"), "utf8")));

  // MCP: directory, per-shop, and the owner's read-only server.
  app.all("/mcp", (req, res) => serveMcp(req, res, () => buildBuyerServer(null, agentIdOf(req))));
  app.all("/s/:slug/mcp", async (req, res) => {
    const m = await merchantBySlug(await getDb(), req.params.slug);
    if (!m) return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Shop not found" }, id: null });
    return serveMcp(req, res, () => buildBuyerServer(m, agentIdOf(req)));
  });
  app.all("/owner/mcp", async (req, res) => {
    const token = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    const m = token ? await merchantByToken(await getDb(), token) : null;
    if (!m) return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Owner key required: Authorization: Bearer <owner key>" }, id: null });
    return serveMcp(req, res, () => buildOwnerServer(m));
  });

  app.post("/webhooks/paypal", (req, res, next) => receiveWebhook(req, res).catch(next));
  installChannelHandlers();
  app.use(adminRouter());
  app.use(demoRouter());
  app.use(uiApi());
  app.use(publicRouter());
  app.use(spaRouter());
  app.use("/api/v1", runsApi());
  app.use("/api/v1", apiRouter());
  app.use(guardRouter());
  app.use(safetyRouter());
  app.use(foundationRouter());
  app.use(webRouter());

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof KeptError) {
      if ((err as any).detail) console.warn(`[kept] ${err.code}: ${(err as any).detail}`);
      // The honest failure state: a plain sentence and a way to try again, never a raw error string.
      if (req.accepts(["html", "json"]) === "html") {
        const back = String(req.get("referer") ?? "/");
        const safeBack = back.startsWith(config.appUrl) || back.startsWith("/") ? back : "/";
        const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        return res.status(err.status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kept</title><link rel="stylesheet" href="/static/app.css"></head><body><main id="main" class="wrap" style="max-width:640px;margin:48px auto;padding:0 16px"><h1>That didn't work</h1><p role="alert">${esc(err.message)}</p><p><a class="btn primary" href="${esc(safeBack)}">Go back and try again</a></p></main></body></html>`);
      }
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    console.error("[kept]", err);
    res.status(500).send("Something went wrong.");
  });
  return app;
}
