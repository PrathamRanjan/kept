import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { plansFor, subscriberByRef, planById } from "../src/store.js";
import { tick } from "../src/worker.js";
import { createApp } from "../src/app.js";
import type { AddressInfo } from "node:net";

// Review fixes from 8 Nov: each was a probe asserting the defect; these assert the correct behaviour.
const actor = { kind: "agent" as const, agentId: "review" };
const rulesText = "One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.";

let db: Db;
let fake: FakePayPal;
let m: any;
let plan: any;
let ref: string;
const sub = () => subscriberByRef(db, ref) as Promise<any>;
const runJobs = async (type?: string) => {
  await db.query(`UPDATE jobs SET run_at = now() WHERE status = 'pending'${type ? ` AND type = '${type}'` : ""}`);
  await tick();
};

beforeEach(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  m = await svc.createMerchant({ name: "Review Roasters", currency: "USD" });
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  await svc.approveRules(m.id, (await svc.previewRules(rulesText)).value, rulesText);
  plan = (await plansFor(db, m.id)).find((p) => p.kind === "regular")!;
  const x = await svc.startSubscription(m, plan.id, { name: "Reviewer" }, actor);
  fake.approve(x.paypalSubscriptionId);
  await svc.syncSubscription(x.ref);
  ref = x.ref;
});
afterEach(async () => {
  await db.close();
});

describe("Kept review fixes", () => {
  it("KP-1: a PayPal read error doesn't erase a pending cancellation; the retry still cancels", async () => {
    (fake as any).failNext = "cancelSubscription";
    expect((await svc.requestCancel(ref, {}, actor)).status).toBe("cancel_pending");
    const originalGet = fake.getSubscription.bind(fake);
    fake.getSubscription = async () => {
      throw new Error("temporary read outage");
    };
    await svc.syncSubscription(ref);
    fake.getSubscription = originalGet;
    expect((await sub()).kept_state).toBe("cancel_pending");
    await runJobs("retry_cancel");
    const s = await sub();
    expect(s.status).toBe("CANCELLED");
    expect(s.cancel_requested_at).toBeNull();
  });

  it("KP-2: cancellation retries never stop; the owner is alerted after five failures", async () => {
    const orig = fake.cancelSubscription.bind(fake);
    fake.cancelSubscription = async () => {
      throw new Error("provider unavailable");
    };
    await svc.requestCancel(ref, {}, actor);
    for (let i = 0; i < 7; i++) await runJobs("retry_cancel");
    expect((await sub()).status).toBe("ACTIVE");
    expect((await db.query<any>("SELECT status FROM jobs WHERE type = 'retry_cancel'")).rows[0].status).toBe("pending");
    expect((await db.query<any>("SELECT count(*)::int AS n FROM event_log WHERE type = 'cancel.stuck'")).rows[0].n).toBe(1);
    expect((await sub()).kept_state).toBe("cancel_pending");
    fake.cancelSubscription = orig;
    await runJobs("retry_cancel");
    expect((await sub()).status).toBe("CANCELLED");
  });

  it("KP-3: a failed acceptance keeps the offer's expiry, so the cancellation still happens", async () => {
    const o = await svc.requestCancel(ref, { reason: "too expensive", hearOffer: true }, actor);
    fake.reviseSubscription = async () => {
      throw new Error("temporary revise outage");
    };
    await expect(svc.respondToOffer(o.offer!.offer_id, true, actor)).rejects.toThrow();
    await db.query("UPDATE offers SET expires_at = now() - interval '1 minute' WHERE id = $1", [o.offer!.offer_id]);
    await runJobs("expire_offer");
    expect((await db.query<any>("SELECT status FROM offers WHERE id = $1", [o.offer!.offer_id])).rows[0].status).toBe("expired");
    expect((await sub()).status).toBe("CANCELLED");
  });

  it("KP-4: policy replay uses the same cooldown a real request saw", async () => {
    const o = await svc.requestCancel(ref, { reason: "travelling", hearOffer: true }, actor);
    await svc.respondToOffer(o.offer!.offer_id, true, actor);
    await svc.resume(ref, actor);
    expect((await svc.requestCancel(ref, { reason: "too expensive after return", hearOffer: true }, actor)).status).toBe("cancelled");
    const replay = await svc.replayRules(m.id, (await svc.previewRules(rulesText)).value);
    const row = replay.rows.find((r) => r.reason === "too expensive after return")!;
    expect(row.before).toMatch(/^no offer/);
    expect(row.after).toMatch(/^no offer/);
  });

  it("KP-5: a promise-to-pay follow-up rescheduled during the quiet period still runs on the promised date", async () => {
    const s = await sub();
    fake.failRenewal(s.paypal_subscription_id);
    await svc.handlePaymentFailed(s.id, "webhook");
    await svc.promisePayment(ref, new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), actor);
    await svc.handlePaymentFailed(s.id, "webhook");
    await db.query("UPDATE jobs SET run_at = now() WHERE dedupe_key = $1", [`followup:${s.id}`]);
    await tick();
    const j = (await db.query<any>("SELECT status, run_at FROM jobs WHERE dedupe_key = $1", [`followup:${s.id}`])).rows[0];
    expect(j.status).toBe("pending");
    expect(new Date(j.run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("KP-6: a scheduled discount isn't counted as kept, and its period doesn't start, until PayPal shows the new plan", async () => {
    const o = await svc.requestCancel(ref, { reason: "too expensive", hearOffer: true }, actor);
    fake.reviseSubscription = async (_id: any, target: any) => ({ approveUrl: null, planId: target }) as any;
    const result: any = await svc.respondToOffer(o.offer!.offer_id, true, actor);
    const s = await sub();
    expect((await planById(db, s.plan_id))!.kind).toBe("regular");
    expect(s.promo_until).toBeNull();
    expect((await db.query<any>("SELECT consent_pending FROM offers WHERE id = $1", [o.offer!.offer_id])).rows[0].consent_pending).toBe(true);
    expect((await db.query<any>("SELECT outcome FROM feedback WHERE subscriber_id = $1", [s.id])).rows[0].outcome).toBe("awaiting_consent");
    expect(result.status).toBe("kept");
  });

  it("KP-7: starting twice with the same key returns the same subscription", async () => {
    const a = await svc.startSubscription(m, plan.id, { name: "Replay" }, actor, "same-key");
    const b = await svc.startSubscription(m, plan.id, { name: "Replay" }, actor, "same-key");
    expect(b.paypalSubscriptionId).toBe(a.paypalSubscriptionId);
    expect(b.ref).toBe(a.ref);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM subscribers WHERE start_key = 'same-key'")).rows[0].n).toBe(1);
  });
  it("KP-8: the subscriber's own page says the cancellation is pending", async () => {
    (fake as any).failNext = "cancelSubscription";
    expect((await svc.requestCancel(ref, {}, actor)).status).toBe("cancel_pending");
    const app: any = await (createApp as any)();
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const text = await (await fetch(`http://127.0.0.1:${port}/manage/${ref}`)).text();
      expect(text).toMatch(/Cancellation pending/);
      expect(text).toMatch(/keeps retrying/);
      // While the cancellation is pending, nothing else is offered (live 9 Nov).
      expect(text).not.toMatch(/Skip next renewal|Switch plan|Cancel subscription/);
      expect((await svc.subscriptionView(ref)).available_actions).toEqual([]);
    } finally {
      server.close();
    }
  });
});
