/**
 * Serves the React front end (web/dist) for the pages it owns. Each page gets a server-rendered <title>,
 * description and, on shop pages, the schema.org JSON-LD and llms.txt link agents read, so nothing an
 * agent or crawler relied on is lost when the page body becomes a client app.
 * If web/dist hasn't been built (unit tests, a fresh clone), these routes fall through to the server pages.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router, Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { money } from "../policy/eligibility.js";
import { merchantBySlug, plansFor, subscriberByRef } from "../store.js";
import { esc } from "./html.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SPA_DIR = join(root, "web", "dist");

/** Pages the React app renders. Everything else stays server-rendered. */
export const SPA_PATHS = ["/", "/demo", "/judge", "/proof", "/ai", "/paypal", "/who-can-move-money", "/accessibility", "/s/:slug", "/manage/:ref", "/dashboard", "/dashboard/members", "/dashboard/approvals"];

export function spaEnabled(): boolean {
  return process.env.KEPT_SPA !== "off" && existsSync(join(SPA_DIR, "index.html"));
}

let cached: string | null = null;
function shell(): string {
  if (!cached || process.env.NODE_ENV !== "production") cached = readFileSync(join(SPA_DIR, "index.html"), "utf8");
  return cached;
}

function render(head: { title: string; description?: string; extra?: string }): string {
  let html = shell().replace(/<title>[^<]*<\/title>/, `<title>${esc(head.title)}</title>`);
  if (head.description) html = html.replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(head.description)}" />`);
  return html.replace("<!--kept:head-->", head.extra ?? "");
}

async function headFor(req: Request): Promise<{ title: string; description?: string; extra?: string; status?: number }> {
  const p = req.path;
  if (p.startsWith("/s/")) {
    const db = await getDb();
    const m = await merchantBySlug(db, req.params.slug);
    if (!m) return { title: "Shop not found · Kept", status: 404 };
    const plans = (await plansFor(db, m.id)).filter((x) => x.kind !== "promo");
    const ld = {
      "@context": "https://schema.org",
      "@type": "Store",
      name: m.name,
      description: m.tagline,
      url: `${config.appUrl}/s/${m.slug}`,
      makesOffer: plans.map((x) => ({
        "@type": "Offer",
        name: x.name,
        description: x.description,
        priceCurrency: m.currency,
        price: money(x.price),
        priceSpecification: { "@type": "UnitPriceSpecification", price: money(x.price), priceCurrency: m.currency, billingDuration: x.interval_count, unitCode: { DAY: "DAY", WEEK: "WEE", MONTH: "MON", YEAR: "ANN" }[x.interval_unit] },
      })),
      potentialAction: { "@type": "Action", name: "Subscribe via MCP", target: `${config.appUrl}/s/${m.slug}/mcp` },
    };
    return {
      title: `${m.name} · subscribe`,
      description: m.tagline ?? undefined,
      extra: `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script><link rel="alternate" type="text/plain" href="/s/${esc(m.slug)}/llms.txt" title="llms.txt">`,
    };
  }
  if (p.startsWith("/manage/")) {
    const s = await subscriberByRef(await getDb(), req.params.ref);
    return s ? { title: "Your subscription · Kept", extra: `<meta name="robots" content="noindex">` } : { title: "Subscription not found · Kept", status: 404, extra: `<meta name="robots" content="noindex">` };
  }
  if (p.startsWith("/dashboard")) return { title: "Today · Kept", extra: `<meta name="robots" content="noindex">` };
  if (p === "/judge") return { title: "For judges · Kept", description: "Three paths through Kept that tick themselves, and what is live versus simulated." };
  const pub: Record<string, string> = { "/proof": "Proof: every evaluation case", "/ai": "The last 20 model calls", "/paypal": "Every PayPal API Kept uses", "/who-can-move-money": "Who can move money", "/accessibility": "Accessibility: what was tested" };
  if (pub[p]) return { title: `${pub[p]} · Kept` };
  if (p === "/demo") return { title: "Try the live demo · Kept" };
  return { title: "Kept: subscriptions people can change in one step" };
}

export function spaRouter(): Router {
  const r = Router();
  r.use("/assets", express.static(join(SPA_DIR, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  for (const f of ["favicon.svg", "og.png", "robots.txt"]) {
    r.get(`/${f}`, (req, res, next) => (existsSync(join(SPA_DIR, f)) ? res.sendFile(join(SPA_DIR, f), { maxAge: "1d" }) : next()));
  }
  const page = async (req: Request, res: Response, next: NextFunction) => {
    if (!spaEnabled()) return next();
    // Old forms and links that pass a flash message still land on the new page.
    try {
      const head = await headFor(req);
      res.status(head.status ?? 200).type("html").set("Cache-Control", "no-cache").send(render(head));
    } catch (e) {
      next(e);
    }
  };
  for (const path of SPA_PATHS) r.get(path, page);
  return r;
}
