import compression from "compression";
import express from "express";
import cookieParser from "cookie-parser";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter } from "./api.js";
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
    next();
  });
  app.use("/static", express.static(join(root, "public"), { maxAge: 0, setHeaders: (res, file) => { if (/[\\/]safety[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=86400"); } }));

  app.get("/healthz", async (_req, res) => {
    try {
      await (await getDb()).query("SELECT 1");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
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
  app.use(uiApi());
  app.use(spaRouter());
  app.use("/api/v1", runsApi());
  app.use("/api/v1", apiRouter());
  app.use(guardRouter());
  app.use(safetyRouter());
  app.use(foundationRouter());
  app.use(webRouter());

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof KeptError) return res.status(err.status).send(err.message);
    console.error("[kept]", err);
    res.status(500).send("Something went wrong.");
  });
  return app;
}
