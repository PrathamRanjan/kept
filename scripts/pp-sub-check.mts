import { PayPalClient } from "../src/paypal/client.ts";
import { config } from "../src/config.ts";
const pp = new PayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, env: config.paypal.env } as any);
for (const id of process.argv.slice(2)) {
  const s: any = await pp.getSubscription(id).catch((e) => ({ error: String(e) }));
  console.log(id, s.status ?? s.error, s.plan_id ?? "", s.status_update_time ?? "", s.billing_info?.last_payment?.amount?.value ?? "");
}
