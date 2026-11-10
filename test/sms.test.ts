import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { notifyParty, setChannelFetch } from "../src/channels/index.js";
import { normalisePhone, twilioSignatureValid } from "../src/channels/sms.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { plansFor, type Merchant } from "../src/store.js";
import { tick } from "../src/worker.js";
import { Client } from "./client.js";
import { isSmsRoute, serveTracked } from "./journey-coverage.js";

// Twilio SMS: verified opt-in, reminders and notices by text with a link, STOP, signed inbound webhook.
// Twilio's API is replaced by a recording double; everything else is the real app.
let db: Db;
let fake: FakePayPal;
let m: Merchant;
let key: string;
let srv: Awaited<ReturnType<typeof serveTracked>>;
const saved = { ...config.channels.twilio };
let sent: { to: string; from: string; body: string }[] = [];
let nextError: { code: number; message: string } | null = null;
const one = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows[0];
const lastCode = () => sent.at(-1)!.body.match(/code is (\d{6})/)![1];
const sign = (params: Record<string, string>) => createHmac("sha1", config.channels.twilio.authToken).update(`${config.appUrl}/webhooks/twilio` + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  Object.assign(config.channels.twilio, { accountSid: "ACtest", authToken: "tw-test-token", from: "+15550000000", apiKeySid: "", apiKeySecret: "", messagingServiceSid: "" });
  setChannelFetch((async (url: string, init: any) => {
    if (!String(url).startsWith("https://api.twilio.com/")) throw new Error(`unexpected fetch ${url}`);
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("ACtest:tw-test-token").toString("base64")}`);
    const f = new URLSearchParams(init.body);
    if (nextError) {
      const e = nextError;
      nextError = null;
      return new Response(JSON.stringify(e), { status: 400 });
    }
    sent.push({ to: f.get("To")!, from: f.get("From")!, body: f.get("Body")! });
    return new Response(JSON.stringify({ sid: `SM${sent.length}` }), { status: 201 });
  }) as any);
  m = await svc.createMerchant({ name: "Text Roasters", tagline: "Beans", currency: "USD", email: "o@example.com" });
  key = (await one("SELECT owner_token FROM merchants WHERE id = $1", [m.id])).owner_token;
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly", "USD")).value);
  await svc.approveRules(m.id, (await svc.previewRules("One skip per quarter. Pause up to 2 months.")).value, "rules");
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  Object.assign(config.channels.twilio, saved);
  setChannelFetch(null);
  await srv?.close();
  setPayPalFactory(null);
});

async function member(name: string) {
  const plan = (await plansFor(db, m.id))[0];
  const out = await svc.startSubscription(m, plan.id, { name, email: `${name.toLowerCase()}@example.com` }, { kind: "web" });
  fake.approve(out.paypalSubscriptionId);
  await svc.syncSubscription(out.ref);
  return { ref: out.ref, id: out.subscriberId };
}

describe("SMS (Twilio)", () => {
  it("normalises numbers and checks Twilio signatures", () => {
    expect(normalisePhone("+65 8148 0996")).toBe("+6581480996");
    expect(normalisePhone("0065-8148-0996")).toBe("+6581480996");
    expect(normalisePhone("81480996")).toBeNull();
    const p = { From: "+6581480996", Body: "status" };
    expect(twilioSignatureValid(`${config.appUrl}/webhooks/twilio`, p, sign(p))).toBe(true);
    expect(twilioSignatureValid(`${config.appUrl}/webhooks/twilio`, { ...p, Body: "cancel" }, sign(p))).toBe(false);
    expect(twilioSignatureValid(`${config.appUrl}/webhooks/twilio`, p, undefined)).toBe(false);
  });

  it("member: consent, texted code, wrong code refused, right code links; reminders arrive by text with the member link", async () => {
    const c = new Client(srv.base);
    const ada = await member("Ada");
    expect((await c.get(`/ui/manage/${ada.ref}`)).json.sms).toEqual({ ready: true, linked: [], pending: null });
    expect((await c.postJson(`/ui/manage/${ada.ref}/sms/start`, { phone: "+65 8148 0996", consent: false })).status).toBe(422);
    expect((await c.postJson(`/ui/manage/${ada.ref}/sms/start`, { phone: "8148", consent: true })).status).toBe(422);
    const st = (await c.postJson(`/ui/manage/${ada.ref}/sms/start`, { phone: "+65 8148 0996", consent: true })).json;
    expect(st.to).toBe("+65••••996");
    expect(sent.at(-1)).toMatchObject({ to: "+6581480996", from: "+15550000000" });
    expect(sent.at(-1)!.body).toMatch(/Reply STOP/);
    expect((await c.get(`/ui/manage/${ada.ref}`)).json.sms.pending).toBe("+65••••996"); // a reload still asks for the code
    // Nothing is linked until the code comes back.
    expect(await one("SELECT * FROM party_links WHERE channel = 'sms'")).toBeUndefined();
    const code = lastCode();
    expect((await c.postJson(`/ui/manage/${ada.ref}/sms/verify`, { code: code === "000000" ? "111111" : "000000" })).status).toBe(422);
    expect((await c.postJson(`/ui/manage/${ada.ref}/sms/verify`, { code })).json.message).toMatch(/Texts are on/);
    expect((await c.postJson(`/ui/manage/${ada.ref}/sms/verify`, { code })).status).toBe(410); // one use only
    expect(await one("SELECT party, party_id FROM party_links WHERE channel = 'sms' AND address = '+6581480996'")).toEqual({ party: "subscriber", party_id: ada.id });
    expect((await c.get(`/ui/manage/${ada.ref}`)).json.sms).toMatchObject({ linked: ["+65••••996"], pending: null });

    // A renewal three days out: the reminder goes by text, with the member page link and no buttons.
    await db.query("UPDATE subscribers SET next_billing_time = now() + interval '3 days' WHERE id = $1", [ada.id]);
    sent = [];
    await svc.sendRenewalReminders(new Date());
    await tick();
    const texts = sent.filter((x) => x.to === "+6581480996");
    expect(texts.map((x) => x.body).join("\n")).toMatch(/texts are on/);
    const reminder = texts.find((x) => /renews on/.test(x.body))!;
    expect(reminder.body).toContain(`${config.appUrl}/manage/${ada.ref}`);
    expect((await one("SELECT status, external_id FROM channel_messages WHERE channel = 'sms' AND body LIKE '%renews on%'"))).toMatchObject({ status: "sent", external_id: expect.stringMatching(/^SM/) });
  });

  it("three codes an hour at most; stop turns texts off", async () => {
    const c = new Client(srv.base);
    const bo = await member("Bo");
    for (let i = 0; i < 3; i++) expect((await c.postJson(`/ui/manage/${bo.ref}/sms/start`, { phone: "+15551230000", consent: true })).status).toBe(200);
    expect((await c.postJson(`/ui/manage/${bo.ref}/sms/start`, { phone: "+15551230000", consent: true })).status).toBe(429);
    await c.postJson(`/ui/manage/${bo.ref}/sms/verify`, { code: lastCode() });
    expect((await c.get(`/ui/manage/${bo.ref}`)).json.sms.linked.length).toBe(1);
    expect((await c.postJson(`/ui/manage/${bo.ref}/sms/stop`, {})).json.message).toMatch(/off/);
    expect((await c.get(`/ui/manage/${bo.ref}`)).json.sms.linked).toEqual([]);
    expect((await c.postJson("/ui/manage/ref_nope/sms/start", { phone: "+15551230000", consent: true })).status).toBe(404);
  });

  it("owner: texts for held approvals carry the approvals link", async () => {
    const owner = new Client(srv.base);
    expect((await owner.post("/login/token", { token: key, next: "/dashboard" })).status).toBe(302);
    expect((await owner.get("/dashboard/channels")).text).toMatch(/Texts \(SMS\)/);
    const r = await owner.post("/dashboard/channels/sms/start", { phone: "+6590000001", consent: "1" });
    expect(decodeURIComponent(r.location ?? "")).toMatch(/code=\+65/);
    expect((await owner.get(r.location!)).text).toMatch(/Code sent to/);
    expect(decodeURIComponent((await owner.post("/dashboard/channels/sms/verify", { code: lastCode() })).location ?? "")).toMatch(/ok=Texts are on/);
    expect((await owner.get("/dashboard/channels")).text).toMatch(/Texts on: \+65/);
    sent = [];
    await notifyParty("owner", m.id, "Kept held a discount 15% (above your limit). Approve or decline.", [{ id: "approve:apr_x", label: "Approve" }]);
    await tick();
    expect(sent.find((x) => x.to === "+6590000001" && /held/.test(x.body))!.body).toContain(`${config.appUrl}/dashboard/approvals`);
    expect(decodeURIComponent((await owner.post("/dashboard/channels/sms/stop", {})).location ?? "")).toMatch(/ok=Texts are off/);
    expect(await one("SELECT * FROM party_links WHERE channel = 'sms' AND party = 'owner'")).toBeUndefined();
  });

  it("inbound: unsigned refused; a linked number can ask for status; STOP and Twilio's 21610 both drop the link", async () => {
    const c = new Client(srv.base);
    const cy = await member("Cy");
    await c.postJson(`/ui/manage/${cy.ref}/sms/start`, { phone: "+6590000002", consent: true });
    await c.postJson(`/ui/manage/${cy.ref}/sms/verify`, { code: lastCode() });
    const post = (p: Record<string, string>, sig?: string) => c.req("POST", "/webhooks/twilio", { form: p, headers: sig ? { "x-twilio-signature": sig } : {} });
    expect((await post({ From: "+6590000002", Body: "status" })).status).toBe(403);
    expect((await post({ From: "+6590000002", Body: "status" }, "bad")).status).toBe(403);
    const ok = await post({ From: "+6590000002", Body: "status" }, sign({ From: "+6590000002", Body: "status" }));
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("<Response></Response>");
    sent = [];
    await tick();
    expect(sent.filter((x) => x.to === "+6590000002" && !/texts are on/.test(x.body)).map((x) => x.body).join(" ")).toMatch(/active/i);
    // A typed reference never links a number.
    await post({ From: "+6590000009", Body: `link subscriber:${cy.ref}` }, sign({ From: "+6590000009", Body: `link subscriber:${cy.ref}` }));
    expect(await one("SELECT * FROM party_links WHERE address = '+6590000009'")).toBeUndefined();
    await post({ From: "+6590000002", Body: "STOP" }, sign({ From: "+6590000002", Body: "STOP" }));
    expect(await one("SELECT * FROM party_links WHERE address = '+6590000002'")).toBeUndefined();
    expect((await one("SELECT status FROM subscribers WHERE id = $1", [cy.id])).status).toBe("ACTIVE"); // STOP stops texts, not the subscription

    // Opted out at the carrier: Twilio refuses with 21610; Kept drops the link and doesn't retry.
    await c.postJson(`/ui/manage/${cy.ref}/sms/start`, { phone: "+6590000003", consent: true });
    await c.postJson(`/ui/manage/${cy.ref}/sms/verify`, { code: lastCode() });
    await tick();
    nextError = { code: 21610, message: "Attempt to send to unsubscribed recipient" };
    await notifyParty("subscriber", cy.id, "Your renewal is soon.");
    await tick();
    expect(await one("SELECT * FROM party_links WHERE address = '+6590000003'")).toBeUndefined();
    expect((await one("SELECT status FROM channel_messages WHERE address = '+6590000003' ORDER BY created_at DESC LIMIT 1")).status).toBe("opted_out");
  });

  it("walked every SMS route with no server error", () => {
    expect(srv.failures).toEqual([]);
    expect(srv.missed((r) => !isSmsRoute(r))).toEqual([]);
  });
});
