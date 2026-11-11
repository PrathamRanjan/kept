import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { decide, decisionsBody } from "../src/ai/decisions.js";
import { NoModelError, setProviderFetch } from "../src/ai/provider.js";
import { scanText } from "../src/safety/rules.js";
import { AMBER_PAY, checkMessage, codeReader, combineReaders, readDecisions, SCAM_QUESTIONS } from "../src/safety/readers.js";
import { DEFAULTS, pickThresholds, thresholds, type Threshold } from "../src/safety/thresholds.js";

// Spec A6 (scam layer v2) and A5.2 (Decisions client). The 10 Nov message is the regression case: polite, at a
// free-mail address, it once got a green "No scam signs found".
const NOV10 = "Hi, we've moved banks. Please send this month's payment to our new PayPal, accounts.emberoak@outlook.com. Thanks so much!";
const PARAPHRASES = [
"Hi, we've moved banks. Please send this month's payment to our new PayPal, accounts.emberoak@outlook.com. Thanks!",
"Our bank details have changed, please use the account below for this invoice.",
"Please note our remittance details were updated last week.",
"We switched to a new bank; pay the attached invoice to the new account.",
"Kindly update our beneficiary information: new IBAN GB29NWBK60161331926819.",
"The old account is being closed, so please pay into this one from now on.",
"Use this account instead for all future payments: 12345678.",
"We are moving our banking to Wise, send payments there going forward.",
"Our PayPal has changed to billing.team@gmail.com.",
"Accounts here: our account has been updated, details in the attached.",
"Please pay to our different account this month, the usual one has an issue.",
"Our payment details changed, can you confirm you'll use the new ones?",
"New bank account for Ember and Oak: BSB 062-000 acct 1234 5678.",
"From today our payouts go to a replaced account, see below.",
"Heads up - we changed banks, please send to the alternative account.",
"Your supplier has moved banks; the remittance should go to the new details.",
"We've transferred our banking to a new provider, kindly redirect payment.",
"Just so you know, the PayPal we use was switched, the new one is pay@roasters.co.",
"Please send this month's payment to our new PayPal.",
"Bank details have been changed for the next payment.",
"Our old bank is no longer active, please use the new details.",
"We've updated our PayPal account; send the balance to finance.emberoak@gmail.com.",
"We moved our account to a different bank, details attached.",
"For security reasons the beneficiary has been changed.",
"Please use our PayPal instead of the card on file: shop.payments@hotmail.com",
"Can you pay into a different bank this time? The usual is frozen.",
"The account you normally pay was closed yesterday.",
"New payment details below; please use them for the renewal.",
"We have switched PayPal accounts. New one: emberoakpay@outlook.com.",
"Change of bank: please update your records with our new IBAN DE89370400440532013000.",
];
const GENUINE = [
"Ember & Oak: your Signature bag renews on 2026-12-10 for 24.00 USD. Nothing to do to keep it.",
"I'm moving abroad, please cancel my account.",
"Please switch me to the Lite plan on my account.",
"I've moved house, can you pause my subscription for two months?",
"Thanks, the new roast is lovely.",
"Cancel it, I'm moving.",
"I changed my mind, keep my subscription going.",
"Can I skip next month? Moving to a new flat.",
];

const th = (): Record<string, Threshold> => Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, { name: k, ...d, calibrated_on: "test", n: 0, precision_at_hold: null, recall_at_hold: null, set_at: null, source: "default" as const }]));
const clearAnswers = (over: Record<string, number> = {}) => Object.fromEntries(SCAM_QUESTIONS.map((q) => [q.name, over[q.name] ?? 0.01])) as Record<string, number>;

describe("A6.3 widened changed-details rule", () => {
  it("fires on the 10 Nov message and all 30 paraphrases", () => {
    expect(scanText(NOV10).fired).toContain("changed_details");
    const missed = PARAPHRASES.filter((t) => !scanText(t).fired.includes("changed_details"));
    expect(missed).toEqual([]);
    expect(PARAPHRASES.length).toBe(30);
  });
  it("does not fire on members' own words about moving or switching plan", () => {
    expect(GENUINE.filter((t) => scanText(t).fired.includes("changed_details"))).toEqual([]);
  });
});

describe("A6.1 reader 3: code", () => {
  it("a destination not on file in a request for money is a hold on its own", () => {
    const r = codeReader(NOV10, { shopName: "Ember & Oak" });
    expect(r.level).toBe("hold");
    expect(r.destinations.map((d) => d.kind)).toContain("email");
    expect(r.reasons.join(" ")).toMatch(/free email address/);
  });
  it("account numbers are masked; Kept's own member link is not a destination", () => {
    const r = codeReader("Use this account instead: account 40112233 for the payment.");
    expect(r.destinations[0].value).toBe("••••2233");
    const own = codeReader(`Your bag renews on 10 Dec. Manage: ${config.appUrl}/manage/sub_x`);
    expect(own.destinations).toEqual([]);
    expect(own.level).toBe("clear");
  });
});

describe("A6.2 never a false all-clear", () => {
  it("all readers clear but the message names somewhere to pay: amber with the phone line", () => {
    const dec = readDecisions(clearAnswers({ names_a_payment_destination: 0.5 }), th());
    const out = combineReaders("Thanks for your order. You can find the receipt in PayPal.", dec, th());
    expect(out.level).toBe("caution");
    expect(out.neverGreen).toBe(AMBER_PAY);
  });
  it("Decisions could not run: never green, and it says why", () => {
    const out = combineReaders("Thanks, the new roast is lovely.", { status: "unavailable", level: "caution", answers: {}, fired: [], destinationP: null, reasons: ["The second check could not run just now, so this result cannot be shown as clear."] }, th());
    expect(out.level).toBe("caution");
    expect(out.neverGreen).toMatch(/cannot be shown as clear/);
  });
  it("a refused question is not decided and routes to a person", () => {
    const a: Record<string, number | "not decided"> = clearAnswers();
    a.impersonation = "not decided";
    expect(readDecisions(a, th()).level).toBe("caution");
  });
  it("green only when every reader is clear and no destination is named", () => {
    expect(combineReaders("Thanks, the new roast is lovely.", readDecisions(clearAnswers(), th()), th()).level).toBe("clear");
  });
  it("the 10 Nov message is held even if the model said nothing", () => {
    expect(combineReaders(NOV10, readDecisions(clearAnswers(), th()), th()).level).toBe("hold");
  });
});

describe("A5.2 Decisions client", () => {
  let db: Db;
  const saved = { provider: config.ai.provider, key: config.ai.openaiKey };
  const sent: any[] = [];
  beforeAll(async () => {
    db = await openDb({ memory: true });
    setDb(db);
    (config.ai as any).provider = "openai";
    (config.ai as any).openaiKey = "sk-test";
    setProviderFetch((async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push({ url, body });
      const text = JSON.stringify(body.input);
      const answers = body.questions.map((q: any) =>
        q.name === "impersonation" && text.includes("REFUSE") ? { type: "refusal", name: q.name, refusal: "cannot" } : { type: "predicate", name: q.name, probability: text.includes("moved banks") && ["changed_payment_details", "asks_for_payment", "names_a_payment_destination"].includes(q.name) ? 0.97 : 0.02 },
      );
      return new Response(JSON.stringify({ model: "gpt-6-luna", answers, usage: { input_tokens: 400, output_tokens: 0 } }), { status: 200 });
    }) as unknown as typeof fetch);
  });
  afterAll(async () => {
    setProviderFetch(null);
    (config.ai as any).provider = saved.provider;
    (config.ai as any).openaiKey = saved.key;
    await db.close();
  });
  it("sends every question in one request to /v1/decisions on gpt-6-luna and logs the call", async () => {
    const r = await decide("hello", SCAM_QUESTIONS, { purpose: "test" });
    expect(sent.at(-1).url).toMatch(/\/v1\/decisions$/);
    expect(sent.at(-1).body.model).toBe("gpt-6-luna");
    expect(sent.at(-1).body.questions).toHaveLength(11);
    expect(r.answers.impersonation.probability).toBe(0.02);
    const row = (await db.query<any>("SELECT purpose, model, ok FROM ai_calls ORDER BY id DESC LIMIT 1")).rows[0];
    expect(row).toMatchObject({ purpose: "decide_test", model: "gpt-6-luna", ok: true });
  });
  it("a refusal comes back as refused", async () => {
    const r = await decide("REFUSE", SCAM_QUESTIONS, { purpose: "test" });
    expect(r.answers.impersonation.refused).toBe(true);
  });
  it("a choice question must offer other", () => {
    expect(() => decisionsBody("x", [{ type: "choice", name: "c", instructions: "?", choices: [{ value: "a", description: "a" }] }])).toThrow(/other/);
  });
  it("the full check holds the 10 Nov message with all three readers", async () => {
    const out = await checkMessage(NOV10, { shopName: "Ember & Oak" });
    expect(out.level).toBe("hold");
    expect(out.readers.decisions.status).toBe("ran");
    expect(out.readers.decisions.level).toBe("hold");
    expect(out.readers.code.level).toBe("hold");
    expect(out.readers.rules.level).toBe("hold");
  });
  it("calibrated thresholds from the committed file are in force", async () => {
    const t = await thresholds();
    expect(t.scam_tactic.source).toBe("calibrated");
  });
  it("no key: NoModelError, and the check is not green", async () => {
    (config.ai as any).openaiKey = "";
    await expect(decide("x", SCAM_QUESTIONS, { purpose: "test" })).rejects.toBeInstanceOf(NoModelError);
    const out = await checkMessage("Thanks, the new roast is lovely.");
    expect(out.level).toBe("caution");
    expect(out.readers.decisions.status).toBe("unavailable");
    (config.ai as any).openaiKey = "sk-test";
  });
});

describe("threshold picking", () => {
  it("separates cleanly separable scores", () => {
    const p = pickThresholds([{ p: 0.9, positive: true }, { p: 0.95, positive: true }, { p: 0.01, positive: false }, { p: 0.05, positive: false }]);
    expect(p.recall).toBe(1);
    expect(p.precision).toBe(1);
  });
});
