import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { checkWallet } from "../src/demo/wallet.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { Client } from "./client.js";
import { isWave1Route, serveTracked } from "./journey-coverage.js";

// Wave 1 of the master improvement spec: saved demo wallet (A2.1), admin pages. Later sections add the
// private demo workspaces (A1), the approval pool (A2.2), health (A4) and the no-fallback AI rules (A11).
let db: Db;
let fake: FakePayPal;
let srv: Awaited<ReturnType<typeof serveTracked>>;
const savedAdmin = config.adminKey;
const savedToken = config.paypal.demoVaultToken;

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  (config as any).adminKey = "admin-test-key-0123456789";
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  (config as any).adminKey = savedAdmin;
  config.paypal.demoVaultToken = savedToken;
  await srv.close();
  setPayPalFactory(null);
});

describe("A2.1 saved demo wallet", () => {
  it("reads the token from PayPal and reports when it is gone", async () => {
    fake.vault.set("PT-DEMO1", { id: "PT-DEMO1", customerId: "C-1", payerEmail: "buyer@example.com" });
    config.paypal.demoVaultToken = "PT-DEMO1";
    const ok = await checkWallet();
    expect(ok.ok).toBe(true);
    expect(ok.token).toBe("PT-…MO1");
    expect(fake.calls.some((c) => c.method === "getPaymentToken" && c.args[0] === "PT-DEMO1")).toBe(true);
    fake.vault.delete("PT-DEMO1");
    const gone = await checkWallet();
    expect(gone.ok).toBe(false);
    expect(gone.detail).toMatch(/re-approval/);
  });

  it("admin pages need the admin key; re-approval exchanges and reads back the new token", async () => {
    const anon = new Client(srv.base);
    expect((await anon.get("/admin")).status).toBe(401);
    expect((await anon.get("/admin/paypal/wallet.json", { accept: "application/json" })).status).toBe(401);
    expect((await anon.req("POST", "/admin/login", { form: { key: "wrong", next: "/admin" } })).status).toBe(401);
    const admin = new Client(srv.base);
    const login = await admin.req("POST", "/admin/login", { form: { key: config.adminKey, next: "/admin/paypal/wallet" } });
    expect(login.status).toBe(302);
    expect((await admin.get("/admin")).status).toBe(200);
    const page = await admin.get("/admin/paypal/wallet");
    expect(page.text).toMatch(/APPROVAL_PENDING/);
    const check = await admin.req("POST", "/admin/paypal/wallet/check");
    expect(check.location).toMatch(/err=/); // the token was deleted above
    const start = await admin.req("POST", "/admin/paypal/wallet/start");
    expect(start.location).toMatch(/sandbox\.paypal\.com/);
    const st = [...fake.setupTokens.values()].at(-1)!;
    expect((await admin.get(`/admin/paypal/wallet/return?approval_token_id=${st.id}`)).location).toMatch(/err=/); // not approved yet
    st.approved = true;
    const done = await admin.get(`/admin/paypal/wallet/return?approval_token_id=${st.id}`);
    expect(done.location).toMatch(/ok=Saved/);
    const j = await new Client(srv.base).get("/admin/paypal/wallet.json?check=1", { authorization: `Bearer ${config.adminKey}` });
    expect(j.json.ok).toBe(true);
    expect(JSON.stringify(j.json)).not.toMatch(/PT-[0-9A-F]{12}/); // masked
    expect((await admin.req("POST", "/admin/logout")).status).toBe(302);
  });
});

describe("route coverage", () => {
  it("every Wave 1 route was reached and none failed", async () => {
    await new Client(srv.base).get("/healthz");
    expect(srv.failures).toEqual([]);
    expect(srv.missed((r) => !isWave1Route(r) || /\/demo\/|\/admin\/(pool|workspaces|showcase)/.test(r))).toEqual([]);
  });
});
