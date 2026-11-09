/**
 * A scripted buyer agent that talks to Kept only through MCP, exactly like Claude or any other client would.
 *   npm run agent:demo -- start      find a shop, subscribe, print the PayPal approval link
 *   npm run agent:demo -- lifecycle  after approval: skip, resume, switch plan, then cancel with one offer
 *   npm run agent:demo -- status
 * Options: --url http://localhost:3000  --plan "Daily"  --accept-offer
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const phase = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? "start";
const base = opt("url", process.env.APP_URL || "http://localhost:3000");
const planWord = opt("plan", "Daily");
const acceptOffer = args.includes("--accept-offer");
const STATE = "data/agent-state.json";

const log = (step: string, data: unknown) => console.log(`\n▶ ${step}\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);

async function connect() {
  const client = new Client({ name: "kept-demo-buyer-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { "X-Agent-Id": "kept-demo-buyer-agent" } } }));
  const call = async (name: string, a: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: a });
    const body = JSON.parse(r.content[0].text);
    if (r.isError) throw new Error(`${name}: ${body.message}`);
    return body;
  };
  return { client, call };
}

async function main() {
  const { client, call } = await connect();
  try {
    if (phase === "start") {
      const found = await call("find_shops", { query: "coffee" });
      log("find_shops(coffee)", found.shops.map((s: any) => ({ shop: s.shop, name: s.name, plans: s.plans.map((p: any) => `${p.name}: ${p.price} ${p.currency} ${p.billing}`) })));
      const shop = found.shops[0];
      const info = await call("shop_info", { shop: shop.shop });
      log("shop_info", info.policies);
      const plan = shop.plans.find((p: any) => p.name.toLowerCase().includes(planWord.toLowerCase())) ?? shop.plans[0];
      const quote = await call("quote", { shop: shop.shop, plan_id: plan.plan_id });
      log("quote", quote);
      const started = await call("start_subscription", { shop: shop.shop, plan_id: plan.plan_id, subscriber_name: "Demo Buyer", idempotency_key: `demo-${Date.now()}` });
      log("start_subscription", started);
      mkdirSync("data", { recursive: true });
      writeFileSync(STATE, JSON.stringify({ shop: shop.shop, ref: started.subscription_ref, plans: shop.plans }, null, 2));
      console.log(`\nOpen this link and approve with a PayPal sandbox buyer account:\n${started.approval_url}\nThen run: npm run agent:demo -- lifecycle`);
      return;
    }
    if (!existsSync(STATE)) throw new Error("Run the start phase first.");
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    if (phase === "status") {
      log("get_subscription", await call("get_subscription", { subscription_ref: st.ref }));
      return;
    }
    if (phase === "lifecycle") {
      let s = await call("get_subscription", { subscription_ref: st.ref });
      log("get_subscription", s);
      if (s.status !== "ACTIVE") throw new Error(`Subscription is ${s.status}; approve it on PayPal first.`);
      log("skip_next", await call("skip_next", { subscription_ref: st.ref, idempotency_key: `skip-${st.ref}` }));
      log("skip_next again with the same key (replay, no second action)", await call("skip_next", { subscription_ref: st.ref, idempotency_key: `skip-${st.ref}` }));
      log("resume", await call("resume", { subscription_ref: st.ref }));
      const other = st.plans.find((p: any) => !p.name.toLowerCase().includes(planWord.toLowerCase()));
      if (other) {
        try {
          log(`switch_plan → ${other.name}`, await call("switch_plan", { subscription_ref: st.ref, plan_id: other.plan_id }));
        } catch (e) {
          log("switch_plan refused", (e as Error).message);
        }
      }
      const c = await call("cancel_subscription", { subscription_ref: st.ref, reason: "travelling for a while", hear_offer: true });
      log("cancel_subscription(hear_offer=true)", c);
      if (c.offer) log(`respond_to_offer(accept=${acceptOffer})`, await call("respond_to_offer", { offer_id: c.offer.offer_id, accept: acceptOffer }));
      s = await call("get_subscription", { subscription_ref: st.ref });
      log("final get_subscription", s);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`\n✖ ${(e as Error).message}`);
  process.exit(1);
});
