import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { dryRun } from "../src/guard/dryrun.js";
import { assessMessage, assessMove, setProtectedMode } from "../src/safety/index.js";
import { loadRiskModel, riskScore } from "../src/safety/risk.js";
import { payeeRules } from "../src/safety/rules.js";
import { DEMO_FAKE_FAILED } from "../src/web/safety.js";

// The safety layer for subscribers (SAFETY_ACCESSIBILITY_SPEC §4, §6 Kept row): the fake failed-payment message is a
// hold with a plain explanation; protected mode holds every agent money move through the gate; a cancel is never held.
describe("messages", () => {
  it("the demo fake failed-payment message is a hold with the fake_failed_payment rule", () => {
    const m = assessMessage(DEMO_FAKE_FAILED);
    expect(m.level).toBe("hold");
    expect(m.rule).toBe("fake_failed_payment");
    expect(m.reasons[0]).toMatch(/never sends a "pay here" link/);
  });
  it("a genuine shop note is clear", () => {
    expect(assessMessage("Hi Ada, your next box ships Tuesday with the Kenyan roast. Skip or pause any time from your subscription page. Thanks!").level).toBe("clear");
  });
  it("the risk model is monotone in the scam features", () => {
    expect(loadRiskModel().features).toContain("t_otp_link");
    const clean = payeeRules({ payeeAgeDays: null, detailsChangedDaysAgo: null, detailsChangeSource: null, amountCents: 1800, historyMedianCents: 1800, velocity10m: 0, velocity24hSumRatio: 1, requestChannelUntrusted: false, hourLocal: 12 }).features;
    expect(riskScore({ ...clean, request_channel_untrusted: 1, t_urgency: 1, t_otp_link: 1 })).toBeGreaterThan(riskScore(clean));
  });
});

describe("gate", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb({ memory: true });
    setDb(db);
  });
  afterEach(async () => {
    await db.close();
  });
  it("an agent refund with no subscriber words is clear; protected mode holds it through the gate; a cancel is never held", async () => {
    await db.query("INSERT INTO merchants (id, slug, name, owner_token) VALUES ('mer_s', 'shop-s', 'Shop S', 'own_s')");
    expect((await assessMove({ action: "refund", merchantId: "mer_s", entity: "subscriber", entityId: "sub_none", cents: 1800 }, db)).level).toBe("clear");
    await setProtectedMode("mer_s", true, ["telegram:1"], db);
    const a = await assessMove({ action: "refund", merchantId: "mer_s", entity: "subscriber", entityId: "sub_none", cents: 1800 }, db);
    expect(a.level).toBe("hold");
    expect(a.rule).toBe("protected_money");
    const d = await dryRun({ action: "refund", merchantId: "mer_s", agentScope: "agent:x", entity: "subscriber", entityId: "sub_none", cents: 1800, trustedCents: [1800] }, { q: db });
    expect(d.decision).toBe("held");
    expect(d.policy).toBe("safety.protected_money");
    const c = await dryRun({ action: "cancel", merchantId: "mer_s", agentScope: "agent:x", entity: "subscriber", entityId: "sub_none" }, { q: db });
    expect(c.decision).toBe("allowed");
  });
});

describe("scam check inputs come from the shop's own records", () => {
  it("reads the hour in the shop's time zone, and only when one is set", async () => {
    const { hourIn, moveContext } = await import("../src/safety/index.js");
    expect(hourIn("Etc/GMT-5", new Date("2026-01-01T00:00:00Z"))).toBe(5);
    expect(hourIn("Asia/Singapore", new Date("2026-01-01T18:00:00Z"))).toBe(2);
    const { openDb, setDb } = await import("../src/db.js");
    const db = await openDb({ memory: true });
    setDb(db);
    const svc = await import("../src/service.js");
    const m = await svc.createMerchant({ name: "Clock Shop", currency: "USD" });
    expect((await moveContext(db, { merchantId: m.id, cents: 100 }, null)).hourLocal).toBe(12);
    const zone = `Etc/GMT${(() => { const off = 3 - new Date().getUTCHours(); const z = -off; return z >= 0 ? `+${z}` : `${z}`; })()}`;
    await db.query("UPDATE merchants SET time_zone = $2 WHERE id = $1", [m.id, zone]);
    expect((await moveContext(db, { merchantId: m.id, cents: 100 }, null)).hourLocal).toBe(hourIn(zone));
    await db.close();
  });
});
