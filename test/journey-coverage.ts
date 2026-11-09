import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Journey coverage: serves an Express app and records which of its routes a test reached,
 * and any 5xx response. A journey test ends by asserting every route was used and none failed.
 */
/** app.all() registers every HTTP verb; count it as one route ("ALL"). */
function verbs(route: any): string[] {
  const ms = Object.keys(route.methods).filter((m) => m !== "_all");
  return route.methods._all || ms.length > 20 ? ["ALL"] : ms.map((m) => m.toUpperCase());
}

export function routeTable(app: any): string[] {
  const out = new Set<string>();
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        const methods = verbs(layer.route);
        for (const p of paths) for (const m of methods) out.add(`${m} ${prefix}${p}`);
      } else if (layer.name === "router" && layer.handle?.stack) {
        let sub = "";
        if (!layer.regexp?.fast_slash) {
          sub = String(layer.regexp.source)
            .replace(/^\^/, "")
            .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
            .replace(/\\\//g, "/");
        }
        walk(layer.handle.stack, prefix + sub);
      }
    }
  };
  walk(app._router?.stack, "");
  return [...out].sort();
}

export async function serveTracked(app: any) {
  const hits = new Set<string>();
  const failures: string[] = [];
  const server = http.createServer((req: any, res) => {
    res.on("finish", () => {
      if (req.route) {
        const paths = Array.isArray(req.route.path) ? req.route.path : [req.route.path];
        const m = verbs(req.route).length === 1 && verbs(req.route)[0] === "ALL" ? "ALL" : req.method;
        hits.add(`${m} ${req.baseUrl ?? ""}${paths[0]}`);
      }
      if (res.statusCode >= 500) failures.push(`${req.method} ${req.url} → ${res.statusCode}`);
    });
    app(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    failures,
    /** Routes the journey never reached, minus any listed (with a reason) in `skip`. */
    missed(skip: Record<string, string> | ((route: string) => boolean) = {}) {
      const table = routeTable(app);
      if (!table.length) throw new Error("No routes found: the coverage check would pass vacuously");
      const skipped = typeof skip === "function" ? skip : (r: string) => r in skip;
      return table.filter((r) => !hits.has(r) && !skipped(r));
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Routes added by the foundation work (guard, compliance, traces, evals, money desk, channels, PWA, judge). */
export const FOUNDATION_ROUTE = /\/(skill\.md|dashboard\/(guard|compliance|traces|eval|money|channels|evidence)|trace\/|channels\/link|webhooks\/(telegram|whatsapp)|manifest\.webmanifest|sw\.js|push\/|judge|api\/v1\/runs|api\/v1\/subscriptions\/:ref\/(runs|invoice))/;
export const isFoundationRoute = (r: string) => FOUNDATION_ROUTE.test(r);
