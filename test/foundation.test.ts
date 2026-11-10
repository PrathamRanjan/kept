import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { plansFor, type Merchant } from "../src/store.js";
import { verifyChain } from "../src/guard/audit.js";
import { isKilled, setKill } from "../src/guard/kill.js";
import { dryRun, pendingApprovals, saveGuardSettings } from "../src/guard/dryrun.js";
import { backtest } from "../src/guard/backtest.js";
import { tick } from "../src/worker.js";
import { Client } from "./client.js";
import { DEMO_FAKE_FAILED } from "../src/web/safety.js";
import { isFoundationRoute, isSmsRoute, isWave1Route, serveTracked } from "./journey-coverage.js";

// Foundation walk: every guard, compliance, trace, eval, money, channel, PWA and judge route is used by an
// owner, a subscriber, an agent and a hostile caller; nothing returns a 5xx; money moves that should be
// held or refused are; cancelling is never held.
let db: Db;
let fake: FakePayPal;
let srv: Awaited<ReturnType<typeof serveTracked>>;
let base: string;
let m: Merchant;
let key: string;
const savedWh = config.paypal.webhookId;
const savedSecret = config.channels.telegramSecret;
const one = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows[0];
const loc = (r: { location: string | null }) => decodeURIComponent(r.location ?? "");
const ok = (r: { status: number; location: string | null }) => {
  expect(r.status, r.location ?? "").toBe(302);
  expect(loc(r)).not.toMatch(/[?&]err=/);
  return r;
};
const agent = { kind: "agent" as const, agentId: "test-agent" };
const rulesText = "One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.";

beforeEach(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  config.paypal.webhookId = "";
  config.channels.telegramSecret = "tg-secret";
  srv = await serveTracked(await (createApp as any)());
  base = srv.base;
  m = await svc.createMerchant({ name: "Foundation Roasters", tagline: "Beans", currency: "USD", email: "owner@example.com" });
  key = (await one("SELECT owner_token FROM merchants WHERE id = $1", [m.id])).owner_token;
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  await svc.approveRules(m.id, (await svc.previewRules(rulesText)).value, rulesText);
});
afterEach(async () => {
  config.paypal.webhookId = savedWh;
  config.channels.telegramSecret = savedSecret;
  await srv.close();
  setPayPalFactory(null);
  await db.close();
});

async function activeSubscriber(name: string) {
  const plan = (await plansFor(db, m.id)).find((p) => p.kind === "regular")!;
  const x = await svc.startSubscription(m, plan.id, { name, email: `${name.toLowerCase()}@example.com` }, agent);
  fake.approve(x.paypalSubscriptionId);
  await svc.syncSubscription(x.ref);
  return { ref: x.ref, id: x.subscriberId, paypalId: x.paypalSubscriptionId, runId: x.runId };
}

describe("Kept foundation", () => {
  it("guard, compliance, traces, evals, money, channels, PWA, judge: every route, no 5xx, cancel never held", async () => {
    const anon = new Client(base);
    const owner = new Client(base);
    ok(await owner.post("/login/token", { token: key, next: "/dashboard" }));
    const auth = { authorization: `Bearer ${key}` };

    // Dashboard shows the new nav and no kill banner yet.
    const dash = (await owner.get("/dashboard")).text;
    expect(dash).toMatch(/href="\/dashboard\/guard"/);
    expect(dash).not.toMatch(/banner kill/);

    /* ---- traces: the start_subscription run is visible to the owner and the subscriber, not to strangers ---- */
    const ada = await activeSubscriber("Ada");
    expect(ada.runId).toMatch(/^run_/);
    expect((await owner.get(`/trace/${ada.runId}`)).text).toMatch(/Agent run/);
    expect((await anon.get(`/trace/${ada.runId}?ref=${ada.ref}`)).status).toBe(200);
    expect((await anon.get(`/trace/${ada.runId}`)).status).toBe(config.demoMode ? 200 : 403);
    expect((await anon.get(`/trace/run_nope`)).status).toBe(404);
    expect((await owner.get("/dashboard/traces")).text).toMatch(/subscribe/);
    expect((await anon.get("/api/v1/runs")).status).toBe(401);
    expect((await anon.get("/api/v1/runs", auth)).json.runs.length).toBeGreaterThan(0);
    expect((await anon.get(`/api/v1/runs/${ada.runId}`, auth)).json.steps.length).toBeGreaterThan(0);
    expect((await anon.get(`/api/v1/runs/${ada.runId}`)).status).toBe(401);
    expect((await anon.get(`/api/v1/subscriptions/${ada.ref}/runs`)).json.runs.length).toBeGreaterThan(0);

    /* ---- guard page, limits, backtest, kill switches, audit ---- */
    /* ---- scam and fraud protection (SAFETY_ACCESSIBILITY_SPEC §4): owner page, model card, a scan, protected mode, the subscriber's check page ---- */
    expect((await owner.get("/dashboard/safety")).text).toMatch(/pay here/);
    expect((await owner.get("/dashboard/safety/model-card")).text).toMatch(/ScamShield/);
    const scan = await owner.req("POST", "/dashboard/safety/scan", { json: { text: DEMO_FAKE_FAILED } });
    expect(scan.status).toBe(200);
    expect(JSON.parse(scan.text).rule).toBe("fake_failed_payment");
    ok(await owner.post("/dashboard/safety/protected", { on: "1" }));
    expect((await owner.get("/dashboard/safety")).text).toMatch(/Turn protected mode off/);
    ok(await owner.post("/dashboard/safety/protected", { on: "0" }));
    expect((await anon.get(`/manage/${ada.ref}/check`)).text).toMatch(/Check a message/);
    expect(JSON.parse((await anon.req("POST", `/manage/${ada.ref}/check/scan`, { json: { text: DEMO_FAKE_FAILED } })).text).level).toBe("hold");

    const guardPage = (await owner.get("/dashboard/guard")).text;
    expect(guardPage).toMatch(/One-call cancel|Fairness|fairness/i);
    expect((await anon.get("/dashboard/guard")).location).toMatch(/login/);
    ok(await owner.post("/dashboard/guard/limits", { pct: "5", cycles: "1", capture_cents: "1000" }));
    ok(await owner.post("/dashboard/guard/adopt", { text: rulesText, pct: "5", cycles: "1" }));
    expect((await owner.get("/dashboard/guard?pct=15&cycles=2")).status).toBe(200);
    ok(await owner.post("/dashboard/guard/suggestions", { field: ["auto_discount_max_pct"] }));
    await saveGuardSettings(m.id, { auto_discount_max_pct: 5, auto_pause_max_cycles: 1, approve_capture_above_cents: 1000 }, "test");
    expect((await owner.get("/dashboard/guard/audit.json")).json.ok).toBe(true);
    expect((await owner.get("/dashboard/guard/kills.json")).json.kills).toBeTruthy();

    // A 15% discount is above the 5% autonomy: the offer is held, the cancel is NOT. Cancel never waits.
    const held = await svc.requestCancel(ada.ref, { reason: "too expensive for me", hearOffer: true }, agent);
    expect(held.status).toBe("cancelled");
    expect((await one("SELECT * FROM event_log WHERE subscriber_id = $1 AND type = 'offer.held'", [ada.id]))).toBeTruthy();
    const pend = await pendingApprovals(m.id);
    expect(pend.filter((a) => a.status === "pending").length).toBe(1);
    const approvalId = pend[0].id;
    // The owner was told through the channel layer (simulated), with approve/decline buttons.
    const notice = await one("SELECT * FROM channel_messages WHERE address = $1 ORDER BY created_at DESC LIMIT 1", [`owner:${m.id}`]);
    expect(notice).toBeTruthy();
    expect(JSON.stringify(notice.buttons)).toMatch(/approve:/);
    expect((await anon.post(`/dashboard/guard/approvals/${approvalId}/approve`)).location).toMatch(/login/);
    ok(await owner.post(`/dashboard/guard/approvals/${approvalId}/approve`));
    expect((await one("SELECT status FROM approvals WHERE id = $1", [approvalId])).status).toBe("approved");
    expect(loc(await owner.post(`/dashboard/guard/approvals/${approvalId}/decline`))).toMatch(/already|Already|ok=/);

    // The backtest replays only this shop's real requests: Ada's held offer and Bo's plain one-step cancel.
    const bo = await activeSubscriber("Bo");
    expect((await svc.requestCancel(bo.ref, { reason: "moving house" }, agent)).status).toBe("cancelled");
    const bt = await backtest(m.id, (await svc.previewRules(rulesText)).value, { auto_discount_max_pct: 5 });
    expect(bt.cases).toBeGreaterThanOrEqual(2);
    expect(bt.rows.map((r) => r.subscriber)).toEqual(expect.arrayContaining(["Ada", "Bo"]));
    expect(bt.wait).toBeGreaterThan(0); // Ada's 15% offer waits at 5% autonomy, as it did live
    expect(bt.cancels_without_offer).toBeGreaterThan(0); // Bo never asked for an offer and cancelled in one step

    // Kill switches: agent kill blocks that agent's money moves but not its cancel; global kill shows the banner.
    const ben = await activeSubscriber("Ben");
    ok(await owner.post("/dashboard/guard/kill", { scope: "agent:test-agent", engaged: "true", reason: "misbehaving" }));
    expect(await isKilled(`merchant:${m.id}:agent:test-agent`)).toBeTruthy();
    await expect(svc.skipNext(ben.ref, agent)).rejects.toMatchObject({ code: "denied" });
    const dCancel = await dryRun({ action: "cancel", merchantId: m.id, agentScope: "agent:test-agent", entity: "subscriber", entityId: ben.id, paypalSubscriptionId: ben.paypalId, merchant: m });
    expect(dCancel.decision).toBe("allowed");
    ok(await owner.post("/dashboard/guard/kill", { scope: "agent:test-agent", engaged: "false" }));
    await setKill("global", true, "drill", "test");
    expect((await owner.get("/dashboard")).text).toMatch(/banner kill/);
    await expect(svc.skipNext(ben.ref, agent)).rejects.toMatchObject({ code: "denied" });
    await setKill("global", false, null, "test");
    const skipped = await svc.skipNext(ben.ref, agent);
    expect(skipped.sub.status).toBe("SUSPENDED");
    await svc.resume(ben.ref, agent);
    expect((await verifyChain()).ok).toBe(true);

    // Passkeys: the start endpoints answer; garbage finish bodies are refused without a 5xx.
    expect((await owner.postJson("/dashboard/guard/passkey/register/start", {})).json.challenge).toBeTruthy();
    expect((await owner.postJson("/dashboard/guard/passkey/register/finish", { chalId: "nope", clientDataJSON: "x", authenticatorData: "x", rawId: "x" })).status).toBeGreaterThanOrEqual(400);
    expect((await owner.postJson("/dashboard/guard/passkey/sign/start", { approvalId })).status).toBeLessThan(500);
    expect((await owner.postJson("/dashboard/guard/passkey/sign/finish", { approvalId, chalId: "nope", rawId: "x", clientDataJSON: "x", authenticatorData: "x", signature: "x" })).status).toBeGreaterThanOrEqual(400);

    /* ---- compliance ---- */
    const comp = (await owner.get("/dashboard/compliance")).text;
    expect(comp).toMatch(/ROSCA-1/);
    expect((await owner.get("/dashboard/compliance?j=US_CA")).text).toMatch(/CA-1/);
    const cj = (await owner.get("/dashboard/compliance.json")).json;
    expect(cj.scorecards.find((c: any) => c.jurisdiction === "US_FEDERAL").failed).toBe(0);

    /* ---- money desk: failed renewal → capture (held above threshold) and invoice ---- */
    fake.failRenewal(ben.paypalId);
    await svc.syncSubscription(ben.ref);
    await svc.handlePaymentFailed(ben.id, "webhook");
    const benRow = await one("SELECT * FROM subscribers WHERE id = $1", [ben.id]);
    expect(benRow.kept_state).toBe("payment_failed");
    expect(Number(benRow.outstanding)).toBeGreaterThan(10); // 24.00 > the 10.00 threshold set above
    const money = (await owner.get("/dashboard/money")).text;
    expect(money).toMatch(/Failed renewals/);
    // An agent asking to invoice 24.00 is above the 10.00 threshold: held for the owner, not refused silently.
    const inv = await anon.postJson(`/api/v1/subscriptions/${ben.ref}/invoice`, {}, { "x-agent-id": "test-agent" });
    expect(inv.status, inv.text).toBe(409);
    expect(inv.json.error).toBe("held");
    expect((await pendingApprovals(m.id)).filter((a) => a.status === "pending" && a.action === "invoice").length).toBe(1);
    await saveGuardSettings(m.id, { approve_capture_above_cents: 5000 }, "test");
    const inv2 = await anon.postJson(`/api/v1/subscriptions/${ben.ref}/invoice`, {}, { "x-agent-id": "test-agent" });
    expect(inv2.json.invoice_id).toMatch(/^INV/);
    expect(inv2.json.run_id).toMatch(/^run_/);
    expect(loc(await owner.post(`/dashboard/money/sub/${ben.ref}/invoice`))).toMatch(/already out/);
    fake.payInvoice(inv2.json.invoice_id);
    ok(await owner.post("/dashboard/money/invoices/check"));
    expect((await one("SELECT status FROM invoices WHERE paypal_invoice_id = $1", [inv2.json.invoice_id])).status).toBe("PAID");
    // The owner's own click is the approval: collecting by hand is never held.
    ok(await owner.post(`/dashboard/money/sub/${ben.ref}/collect`));
    expect((await owner.get("/dashboard/money?lookup=1")).text).toMatch(/transactions/);
    expect((await owner.get("/dashboard/money/transactions.json")).json.transactions).toBeTruthy();
    expect((await anon.get("/dashboard/money/transactions.json")).status).toBe(401);
    // A real failed renewal (PayPal reports it), then the owner collects the balance.
    const cara = await activeSubscriber("Cara");
    fake.failRenewal(cara.paypalId);
    await svc.syncSubscription(cara.ref);
    await svc.handlePaymentFailed(cara.id, "webhook");
    expect(loc(await owner.post(`/dashboard/money/sub/${cara.ref}/collect`))).toMatch(/Collected/);

    /* ---- evals ---- */
    expect((await owner.get("/dashboard/eval")).text).toMatch(/Evals/);
    // Running the evals spends model credit and rewrites the published files: an owner is refused, the admin runs them.
    const refused = await owner.post("/dashboard/eval/run", { suite: "reasons" });
    expect(refused.location ?? "").toMatch(/err=/);
    const savedKey = config.adminKey;
    (config as any).adminKey = "admin-test-key-0123456789";
    await owner.post("/admin/login", { key: config.adminKey, next: "/admin" });
    ok(await owner.post("/dashboard/eval/run", { suite: "reasons" }));
    const evalPage = (await owner.get("/dashboard/eval?suite=reasons&arm=rules&outcome=wrong&trap=injection")).text;
    expect(evalPage).toMatch(/rules/);
    expect((await owner.get("/dashboard/eval.csv?suite=reasons")).text).toMatch(/case_id/);
    expect((await owner.get("/dashboard/eval/reasons.md")).text).toMatch(/#/);
    const dan = await activeSubscriber("Dan");
    ok(await owner.post("/dashboard/eval/run", { suite: "adversarial" }));
    expect((await owner.get("/dashboard/eval?suite=adversarial")).text).toMatch(/guard/);
    expect((await owner.get("/dashboard/eval/adversarial.md")).text).toMatch(/hostile|adversarial/i);
    (config as any).adminKey = savedKey;
    // The harness restored every kill switch and no PayPal write happened to Dan.
    expect((await isKilled("global"))?.engaged ?? false).toBe(false);
    expect((await one("SELECT status FROM subscribers WHERE id = $1", [dan.id])).status).toBe("ACTIVE");

    /* ---- channels: the in-app record, Telegram linking, inbound commands, webhooks ---- */
    expect((await owner.get("/dashboard/channels")).text).toMatch(/Telegram/);
    expect((await owner.get("/dashboard/channels")).text).not.toMatch(/simulat/i);
    const tg = async (chat: number, text: string) => expect((await anon.postJson("/webhooks/telegram", { message: { chat: { id: chat }, text } }, { "x-telegram-bot-api-secret-token": "tg-secret" })).status).toBe(200);
    await tg(4242, `link subscriber:${dan.ref}`);
    expect(await one("SELECT * FROM party_links WHERE channel = 'telegram' AND address = '4242'")).toMatchObject({ party: "subscriber", party_id: dan.id });
    await tg(4242, "status");
    const last = await one("SELECT body, status FROM channel_messages WHERE channel = 'telegram' AND address = '4242' AND direction = 'out' ORDER BY created_at DESC LIMIT 1");
    expect(last.body).toMatch(/ACTIVE|active/);
    // Every notice to Dan now goes to his Telegram chat and is kept in the in-app record.
    await tg(4242, "cancel");
    expect((await one("SELECT status FROM subscribers WHERE id = $1", [dan.id])).status).toBe("CANCELLED");
    expect((await one("SELECT count(*) AS c FROM channel_messages WHERE channel = 'simulator' OR status = 'simulated'")).c).toBe(0);
    expect((await anon.postJson("/webhooks/telegram", { message: { chat: { id: 1 }, text: "hi" } })).status).toBe(401);
    expect((await anon.postJson("/webhooks/telegram", { message: { chat: { id: 1 }, text: `link subscriber:${ada.ref}` } }, { "x-telegram-bot-api-secret-token": "tg-secret" })).status).toBe(200);
    expect((await anon.get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=kept-verify&hub.challenge=abc")).text).toBe("abc");
    expect((await anon.get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong")).status).toBe(403);
    expect((await anon.postJson("/webhooks/whatsapp", { entry: [{ changes: [{ value: { messages: [{ from: "15550001", text: { body: "status" } }] } }] }] })).status).toBe(200);

    /* ---- PWA ---- */
    expect((await anon.get("/manifest.webmanifest")).json.name).toBe("Kept");
    expect((await anon.get("/skill.md")).text).toMatch(/kept-subscriptions/);
    expect((await anon.get("/sw.js")).text).toMatch(/push/);
    expect((await anon.get("/push/public-key")).status).toBe(200);
    expect((await anon.postJson("/push/subscribe", { endpoint: "https://push.example/x", keys: {} })).status).toBe(401);
    expect((await anon.postJson(`/push/subscribe?ref=${ada.ref}`, { endpoint: "https://push.example/x", keys: {} })).json.ok).toBe(true);
    expect((await owner.postJson("/push/subscribe", { endpoint: "https://push.example/o", keys: {} })).status).toBe(200);

    /* ---- evidence and judge mode ---- */
    expect((await owner.get("/dashboard/evidence")).text).toMatch(/what is real/i);
    const judge = new Client(base);
    expect((await judge.get("/judge")).text).toMatch(/beat 1/);
    expect((await judge.get("/judge?beat=3")).text).toMatch(/beat 4/);
    expect((await judge.get("/judge/reset")).location).toBe("/judge");

    /* ---- MCP additions: buyer get_trace with ownership; owner read-only tools ---- */
    const mcp = async (path: string, headers: Record<string, string>, name: string, args: Record<string, unknown>) => {
      const c = new McpClient({ name: "foundation", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers } }));
      const r: any = await c.callTool({ name, arguments: args });
      await c.close();
      return { ...JSON.parse(r.content[0].text), isError: r.isError };
    };
    const t1 = await mcp(`/s/${m.slug}/mcp`, { "X-Agent-Id": "test-agent" }, "get_trace", { subscription_ref: ada.ref });
    expect(t1.runs.length).toBeGreaterThan(0);
    const t2 = await mcp(`/s/${m.slug}/mcp`, { "X-Agent-Id": "test-agent" }, "get_trace", { subscription_ref: ada.ref, run_id: ada.runId });
    expect(t2.steps.length).toBeGreaterThan(0);
    const t3 = await mcp(`/s/${m.slug}/mcp`, { "X-Agent-Id": "test-agent" }, "get_trace", { subscription_ref: ben.ref, run_id: ada.runId });
    expect(t3.error).toBe("not_found");
    const ownerHdr = { Authorization: `Bearer ${key}` };
    expect((await mcp("/owner/mcp", ownerHdr, "search_transactions", { days: 7 })).transactions).toBeTruthy();
    expect((await mcp("/owner/mcp", ownerHdr, "compliance_scorecard", { jurisdiction: "US_CA" })).scorecards[0].jurisdiction).toBe("US_CA");
    expect((await mcp("/owner/mcp", ownerHdr, "fairness", {})).one_call_cancel_rate ?? 0).toBeGreaterThanOrEqual(0);
    expect((await mcp("/owner/mcp", ownerHdr, "pending_approvals", {})).approvals).toBeTruthy();
    expect((await mcp("/owner/mcp", ownerHdr, "recent_runs", { limit: 5 })).runs.length).toBeGreaterThan(0);

    // Worker: the slow jobs run without error (reminders, invoice check).
    await db.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'");
    await tick();
    await svc.sendRenewalReminders(new Date());

    expect(srv.failures).toEqual([]);
    expect(srv.missed((r) => !isFoundationRoute(r) || isSmsRoute(r) || isWave1Route(r))).toEqual([]); // SMS routes are walked in sms.test.ts
  });
});
