import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeSchema, requestBody } from "../src/ai/provider.js";

// Structural guarantees: the model layer never imports PayPal, no model schema can carry a money field,
// the API key never appears in a request body, and every PayPal write in the service runs behind the gate.
const root = join(import.meta.dirname ?? __dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

describe("structural", () => {
  it("src/ai and src/brain never import the PayPal client or the executor", () => {
    for (const f of [...walk(join(root, "src", "ai")), ...walk(join(root, "src", "brain"))]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from "\.\.\/paypal\/(client|index|executor)\.js"/);
      expect(src, f).not.toMatch(/from "\.\.\/executor\.js"/);
    }
  });

  it("no model schema names a money or PayPal field", () => {
    const src = readFileSync(join(root, "src", "brain", "openai.ts"), "utf8");
    expect(src).toMatch(/schema:/);
    expect(src).not.toMatch(/\b(new_price|plan_id|subscription_id|paypal_\w+|amount_cents|capture)\s*:\s*\{/);
    expect(() => assertSafeSchema({ type: "object", properties: { new_price: { type: "number" } } })).toThrow();
    expect(() => assertSafeSchema({ type: "object", properties: { nested: { type: "object", properties: { paypal_subscription_id: { type: "string" } } } } })).toThrow();
    expect(() => assertSafeSchema({ type: "object", properties: { price_quote: { type: "number" }, name: { type: "string" } } })).not.toThrow();
  });

  it("the API key is never part of a request body", () => {
    const sentinel = "sk-SENTINEL-DO-NOT-SEND";
    const schema = { type: "object", properties: { x: { type: "string" } } };
    const body = JSON.stringify(requestBody("gpt-5.5", { purpose: "classify_reason", tier: "classify", system: "classify this", parts: [{ type: "text", text: "money is tight" }], schemaName: "t", schema }, schema));
    // The key travels only as the Authorization header; nothing in the body derives from config.ai.openaiKey.
    expect(body).not.toContain(sentinel);
    expect(body).not.toMatch(/"api_key"|"authorization"|Bearer|sk-/i);
    expect(body).toMatch(/"store":false/);
  });

  it("every PayPal write in the service is inside a function that gates", () => {
    const src = readFileSync(join(root, "src", "service.ts"), "utf8");
    const fnStarts = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((x) => ({ name: x[1], at: x.index! }));
    const fnOf = (i: number) => { let cur = fnStarts[0]; for (const f of fnStarts) if (f.at <= i) cur = f; return cur; };
    const fnBody = (f: { at: number }) => { const n = fnStarts.find((x) => x.at > f.at); return src.slice(f.at, n ? n.at : src.length); };
    const writes = [...src.matchAll(/exec\.(createSubscription|suspend|activate|cancel|revise|captureOutstanding)\(/g)];
    expect(writes.length).toBeGreaterThan(3);
    for (const w of writes) {
      const f = fnOf(w.index!);
      const body = fnBody(f);
      // Either the function gates itself or it is the cancel path (gated by requestCancel/doCancel before it runs).
      expect(/\bgate\(/.test(body) || /^(cancelDurably|retryCancel|doCancel)$/.test(f.name), `${f.name} calls exec.${w[1]} without a gate`).toBe(true);
    }
  });
});
