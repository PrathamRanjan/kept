import { describe, expect, it } from "vitest";
import { PayPalClient } from "../src/paypal/client.js";
import { PayPalError } from "../src/paypal/types.js";

// Live 9 Nov (Everyday): a refund call answered "PREVIOUS_REQUEST_IN_PROGRESS" had in fact been applied by PayPal.
// That answer means PayPal is still working on this request id: it must never be treated as a refusal.
function fakeFetch(busyTimes: number) {
  const requestIds: (string | null)[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600, scope: "", app_id: "a" }), { status: 200 });
    requestIds.push(new Headers(init?.headers).get("PayPal-Request-Id"));
    if (n++ < busyTimes) return new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "A previous request on this resource is currently in progress.", details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }] }), { status: 422 });
    return new Response(JSON.stringify({ id: "REFUND1", status: "COMPLETED" }), { status: 201 });
  }) as unknown as typeof fetch;
  return { f, requestIds };
}
const client = (f: typeof fetch) => new PayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox" } as any, f) as any;

describe("PayPal client: request in progress", () => {
  it("waits and resends the same request id; the second answer is used", async () => {
    const { f, requestIds } = fakeFetch(1);
    const out = await client(f).call("POST", "/v2/payments/captures/CAP1/refund", { amount: { value: "1.00", currency_code: "USD" } }, { requestId: "refund:1" });
    expect(JSON.stringify(out)).toContain("REFUND1");
    expect(requestIds).toEqual(["refund:1", "refund:1"]);
  }, 20000);

  it("if PayPal keeps saying in progress, the outcome is reported as unknown, never as a refusal", async () => {
    const { f, requestIds } = fakeFetch(10);
    const e = await client(f).call("POST", "/v2/payments/captures/CAP1/refund", {}, { requestId: "refund:2" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(PayPalError);
    expect(String((e as Error).message)).toMatch(/outcome unknown/);
    expect(new Set(requestIds)).toEqual(new Set(["refund:2"]));
  }, 20000);
});
