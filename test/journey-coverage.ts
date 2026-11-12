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
export const FOUNDATION_ROUTE = /\/(skill\.md|manage\/:ref\/check|dashboard\/(guard|safety|compliance|traces|eval|money|channels|evidence)|trace\/|channels\/link|webhooks\/(telegram|whatsapp)|manifest\.webmanifest|sw\.js|push\/|judge|api\/v1\/runs|api\/v1\/subscriptions\/:ref\/(runs|invoice))/;
export const isFoundationRoute = (r: string) => FOUNDATION_ROUTE.test(r);

/** Routes of the React UI's JSON API and page shell; walked in ui.test.ts. */
export const UI_ROUTE = /^(GET|POST) \/(ui\/|demo$|dashboard\/(members|approvals)$|favicon\.svg$|robots\.txt$|og\.png$)/;
export const isUiRoute = (r: string) => UI_ROUTE.test(r);

/** Text-message (Twilio) routes; walked in sms.test.ts. */
export const SMS_ROUTE = /\/(dashboard\/channels\/sms\/|webhooks\/twilio|ui\/manage\/:ref\/sms\/)/;
export const isSmsRoute = (r: string) => SMS_ROUTE.test(r);

/** Wave 1 routes (admin, wallet, pool, private demo workspaces, health); walked in wave1.test.ts. */
export const WAVE1_ROUTE = /^(GET|POST|ALL) \/(admin|demo\/|healthz)/;
export const isWave1Route = (r: string) => WAVE1_ROUTE.test(r);

/** Wave 2 routes (judge data, public proof pages, streamed Ask and assistant); walked in wave2.test.ts. */
export const WAVE2_ROUTE = /^(GET|POST) \/(api\/public\/|proof$|ai$|paypal$|who-can-move-money$|accessibility$|ui\/owner\/ask\/stream$|ui\/manage\/:ref\/assistant\/stream$)/;
export const isWave2Route = (r: string) => WAVE2_ROUTE.test(r);

/** Wave 3 routes (the cancel widget); walked in wave3.test.ts. */
export const WAVE3_ROUTE = /^(GET \/widget\.js|POST \/ui\/voice\/session)$/;
export const isWave3Route = (r: string) => WAVE3_ROUTE.test(r);

/** Look and Say and the language switch: the member's language and the talk before cancelling; walked in looksay.test.ts. */
export const LOOKSAY_ROUTE = /^POST \/ui\/manage\/:ref\/(lang|negotiate)$/;
export const isLookSayRoute = (r: string) => LOOKSAY_ROUTE.test(r);
