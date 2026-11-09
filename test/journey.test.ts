import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { tick } from "../src/worker.js";
import { Client } from "./client.js";
import { isFoundationRoute, serveTracked } from "./journey-coverage.js";

// Acceptance journey: a shop owner onboards from nothing (plans and rules from plain words, replayed
// before approval), subscribers use every action on the web and over REST, a cancellation survives a
// forced PayPal failure, the owner works the dashboard, and agents use all three MCP servers.
// It fails if any route is never used or any request returns a 5xx.
let db: Db;
let fake: FakePayPal;
let srv: Awaited<ReturnType<typeof serveTracked>>;
let base: string;
const savedWh = config.paypal.webhookId;

const one = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows[0];
const loc = (r: { location: string | null }) => decodeURIComponent(r.location ?? "");
const ok = (r: { status: number; location: string | null }) => {
  expect(r.status, r.location ?? "").toBe(302);
  expect(loc(r)).not.toMatch(/[?&]err=/);
  return r;
};
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The named inputs of the form posting to `action`, with their current values (as a browser would send). */
function formOf(page: string, action: string): Record<string, string> {
  const start = page.indexOf(`action="${action}"`);
  expect(start, `form ${action}`).toBeGreaterThan(-1);
  const body = page.slice(start, page.indexOf("</form>", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]] = unescape(m[2]);
  for (const m of body.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/g)) {
    const sel = m[2].match(/<option(?: value="([^"]*)")? selected>([^<]*)</);
    out[m[1]] = sel ? sel[1] ?? sel[2] : (m[2].match(/<option(?: value="([^"]*)")?>([^<]*)</)?.slice(1).find(Boolean) ?? "");
  }
  return out;
}
const runJobs = async () => {
  await db.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'");
  await tick();
};

beforeEach(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  config.paypal.webhookId = "";
  srv = await serveTracked(await (createApp as any)());
  base = srv.base;
});
afterEach(async () => {
  config.paypal.webhookId = savedWh;
  await srv.close();
  setPayPalFactory(null);
  await db.close();
});

describe("Kept acceptance journey", () => {
  it("owner, subscribers and agents through every feature, with no route unused and no server error", async () => {
    const anon = new Client(base);
    for (const u of ["/healthz", "/", "/agents", "/llms.txt", "/openapi.yaml", "/login", "/onboard"]) expect((await anon.get(u)).status, u).toBe(200);

    // Onboarding: shop → plans from plain words → rules from plain words → done. The owner key is shown
    // once on the page, never in a URL.
    const owner = new Client(base);
    const shopRes = ok(await owner.post("/onboard/shop", { name: "Ember Oak Coffee Club", tagline: "Fresh beans monthly", currency: "USD", email: "owner@example.com", pp: "env" }));
    expect(shopRes.location).not.toMatch(/own_/);
    const plansPage = (await owner.get("/onboard/plans")).text;
    expect(plansPage).toMatch(/Save your owner key now/);
    const key = (await one("SELECT owner_token, slug FROM merchants")).owner_token as string;
    const slug = (await one("SELECT slug FROM merchants")).slug as string;
    expect(plansPage).toContain(key);
    const preview = (await owner.post("/onboard/plans/preview", { text: "Signature bag $24 monthly\nHalf bag (Lite) $12 monthly" })).text;
    ok(await owner.post("/onboard/plans/create", formOf(preview, "/onboard/plans/create")));
    expect((await owner.get("/onboard/rules")).status).toBe(200);
    const rulesText = "One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.";
    const rp = (await owner.post("/onboard/rules/preview", { text: rulesText })).text;
    expect(rp).toMatch(/Exact rules to approve/);
    ok(await owner.post("/onboard/rules/approve", formOf(rp, "/onboard/rules/approve")));
    expect((await owner.get("/onboard/done")).status).toBe(200);
    const plans = (await anon.get(`/api/v1/shops/${slug}/plans`)).json.plans;
    const regular = plans.find((p: any) => !p.lighter_plan).plan_id;
    const lite = plans.find((p: any) => p.lighter_plan).plan_id;

    // Sign-in three ways: owner key, the demo button, and Log in with PayPal (matched by the owner's email).
    ok(await owner.post("/logout"));
    expect(loc(await owner.post("/login/token", { token: "own_wrong" }))).toMatch(/didn't match/);
    ok(await owner.post("/login/token", { token: key, next: "/dashboard" }));
    ok(await new Client(base).post("/login/demo"));
    expect((await anon.get("/auth/paypal")).location).toMatch(/paypal\.com\/connect/);
    expect(loc(await new Client(base).get("/auth/paypal/callback"))).toMatch(/cancelled/);
    expect(loc(ok(await new Client(base).get("/auth/paypal/callback?code=fake-code")))).toBe("/dashboard");

    // A subscriber joins on the shop page, approves on PayPal and lands on their own page.
    expect((await anon.get(`/s/${slug}`)).text).toMatch(/Ember Oak/);
    const sub = await anon.post(`/s/${slug}/subscribe`, { plan_id: regular, name: "Ada", email: "ada@example.com" });
    const ada = await one("SELECT * FROM subscribers WHERE subscriber_email = 'ada@example.com'");
    expect(sub.location).toMatch(/paypal/);
    expect(loc(await anon.get(`/r/${ada.ref}?cancelled=1`))).toMatch(/didn't approve/);
    fake.approve(ada.paypal_subscription_id);
    expect(loc(ok(await anon.get(`/r/${ada.ref}`)))).toMatch(/subscribed/);
    const manage = (path: string, body: Record<string, string> = {}) => anon.post(`/manage/${ada.ref}/${path}`, body);
    expect((await anon.get(`/manage/${ada.ref}`)).text).toMatch(/Cancel subscription/);
    ok(await manage("skip"));
    expect(loc(await manage("skip"))).toMatch(/err=/); // one skip per quarter
    ok(await manage("resume"));
    expect(loc(await manage("pause", { cycles: "3" }))).toMatch(/err=/); // over the 2-month limit
    ok(await manage("pause", { cycles: "1" }));
    ok(await manage("resume"));
    ok(await manage("switch", { plan_id: lite }));

    // A renewal fails (simulated from the dashboard): Ada promises a date, then says it's fixed.
    expect((await owner.get("/dashboard")).text).toMatch(/Kept by fair offers/);
    ok(await owner.post(`/dashboard/sub/${ada.ref}/simulate-failure`));
    ok(await manage("promise", { date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) }));
    expect((await manage("payment-fixed")).status).toBe(302);

    // Ada cancels and asks to hear one offer; she declines it. PayPal refuses the first cancel call:
    // her page says it's pending, and the retry cancels.
    const c1 = ok(await manage("cancel", { reason: "moving abroad", hear_offer: "1" }));
    expect(loc(c1)).toMatch(/one offer/);
    const offer = await one("SELECT id FROM offers WHERE subscriber_id = $1 AND status = 'open'", [ada.id]);
    // The owner arms the failure lab: PayPal's next cancel call fails once.
    expect(loc(await anon.post("/dashboard/fault", { method: "cancelSubscription" }))).toMatch(/login|err=/);
    ok(await owner.post("/dashboard/fault", { method: "cancelSubscription" }));
    expect((await owner.get("/dashboard")).text).toMatch(/Armed: cancelSubscription/);
    ok(await anon.post(`/offer/${offer.id}/decline`));
    expect((await anon.get(`/manage/${ada.ref}`)).text).toMatch(/Cancellation pending/);
    await runJobs();
    expect((await one("SELECT status FROM subscribers WHERE id = $1", [ada.id])).status).toBe("CANCELLED");

    // Ben, over REST with an idempotency key: every action, an offer accepted over the API.
    const auth = { authorization: `Bearer ${key}` };
    const start = () => anon.req("POST", `/api/v1/shops/${slug}/subscriptions`, { json: { plan_id: regular, subscriber_name: "Ben", subscriber_email: "ben@example.com" }, headers: { "idempotency-key": "ben-1" } });
    const s1 = (await start()).json;
    expect((await start()).json.subscription_ref).toBe(s1.subscription_ref);
    fake.approve(s1.paypal_subscription_id);
    const ref = s1.subscription_ref;
    // One-tap Telegram: the member's one-time code links their chat once; the owner's button opens the bot with a code too.
    const tgm = await anon.post(`/manage/${ref}/connect/telegram`, {});
    expect(tgm.status).toBe(303);
    const mcode = String(tgm.location).split("start=kept-")[1];
    await anon.postJson("/webhooks/telegram", { message: { chat: { id: 4242 }, text: "/start " + mcode } });
    expect((await one("SELECT party FROM party_links WHERE channel = 'telegram' AND address = '4242'"))?.party).toBe("subscriber");
    await anon.postJson("/webhooks/telegram", { message: { chat: { id: 4243 }, text: "/start " + mcode } });
    expect(await one("SELECT party FROM party_links WHERE channel = 'telegram' AND address = '4243'")).toBeUndefined();
    expect(String((await owner.post("/connect/telegram", {})).location)).toMatch(/t\.me\/.+start=kept-/);
    expect((await anon.get(`/api/v1/subscriptions/${ref}`)).json.status).toBe("ACTIVE");
    expect((await anon.postJson(`/api/v1/subscriptions/${ref}/skip`, {})).json.resumes_at).toBeTruthy();
    await anon.postJson(`/api/v1/subscriptions/${ref}/resume`, {});
    expect((await anon.postJson(`/api/v1/subscriptions/${ref}/pause`, { cycles: 1 })).json.resumes_at).toBeTruthy();
    await anon.postJson(`/api/v1/subscriptions/${ref}/resume`, {});
    expect((await anon.postJson(`/api/v1/subscriptions/${ref}/switch`, { plan_id: lite })).json.plan).toMatch(/Lite|Half/);
    await anon.postJson(`/api/v1/subscriptions/${ref}/switch`, { plan_id: regular });
    fake.failRenewal(s1.paypal_subscription_id);
    ok(await owner.post(`/dashboard/sub/${ref}/sync`));
    expect((await anon.postJson(`/api/v1/subscriptions/${ref}/payment-fixed`, {})).status).toBe(200);
    const cancel = (await anon.postJson(`/api/v1/subscriptions/${ref}/cancel`, { reason: "too expensive", hear_offer: true })).json;
    expect(cancel.status).toBe("offer_open");
    const kept = (await anon.postJson(`/api/v1/offers/${cancel.offer.offer_id}/respond`, { accept: true })).json;
    expect(kept.status).toBe("kept");

    // Owner: dashboard calendar, reconcile, webhook registration; the owner API with the key only.
    expect((await owner.get("/dashboard/calendar.json")).json.resources.length).toBeGreaterThan(0);
    ok(await owner.post("/dashboard/reconcile"));
    ok(await owner.post("/dashboard/webhook"));
    expect((await anon.get("/api/v1/owner/stats")).status).toBe(401);
    expect((await anon.get("/api/v1/owner/stats", auth)).json.offersMade).toBeGreaterThan(0);
    expect((await anon.get("/api/v1/owner/subscribers", auth)).json.subscribers.length).toBeGreaterThanOrEqual(2);
    expect((await anon.get("/api/v1/owner/events", auth)).status).toBe(200);
    expect((await anon.get("/api/v1/owner/calendar", auth)).json.events).toBeTruthy();
    expect((await anon.req("POST", "/api/v1/owner/ask", { json: { question: "why are people cancelling?" }, headers: auth })).json.answer).toMatch(/reason/i);
    expect((await anon.req("POST", "/api/v1/owner/reconcile", { json: {}, headers: auth })).status).toBe(200);
    expect((await anon.get("/api/v1/shops")).json.shops[0].plans.length).toBe(2);
    expect((await anon.get(`/api/v1/shops/${slug}`)).status).toBe(200);
    expect(await (await fetch(`${base}/s/${slug}/llms.txt`)).text()).toMatch(/cancel_subscription always cancels/);

    // Agents: the public directory, the shop's own server, and the owner's read-only server (key only).
    const tools = async (path: string, headers: Record<string, string> = {}) => {
      const c = new McpClient({ name: "journey", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers } }));
      const names = (await c.listTools()).tools.map((t) => t.name);
      await c.close();
      return names;
    };
    expect(await tools("/mcp", { "X-Agent-Id": "journey-agent" })).toEqual(expect.arrayContaining(["find_shops", "start_subscription", "cancel_subscription"]));
    expect(await tools(`/s/${slug}/mcp`)).toEqual(expect.arrayContaining(["cancel_subscription"]));
    expect((await fetch(`${base}/owner/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status).toBe(401);
    expect(await tools("/owner/mcp", { Authorization: `Bearer ${key}` })).toEqual(expect.arrayContaining(["ask"]));

    // Webhooks: unsigned refused; signed processed (PayPal shows Ben cancelled elsewhere).
    const ev = { id: "WH-J1", event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: s1.paypal_subscription_id } };
    expect((await anon.postJson("/webhooks/paypal", ev)).status).toBe(400);
    config.paypal.webhookId = "WH-FAKE";
    fake.subs.get(s1.paypal_subscription_id)!.status = "CANCELLED";
    expect((await anon.postJson("/webhooks/paypal", { ...ev, id: "WH-J2" }, { "paypal-transmission-sig": "valid-fake-signature" })).status).toBe(200);
    await runJobs();
    expect((await one("SELECT status FROM subscribers WHERE ref = $1", [ref])).status).toBe("CANCELLED");

    expect(srv.failures).toEqual([]);
    expect(srv.missed(isFoundationRoute)).toEqual([]); // foundation routes are walked in foundation.test.ts
  });
});
