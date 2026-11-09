import { PayPalClient } from "../src/paypal/client.ts";
import { config } from "../src/config.ts";
const pp = new PayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, env: config.paypal.env });
for (const arg of process.argv.slice(2)) {
  const [kind, id] = arg.split(":");
  const r: any = await (kind === "order" ? pp.getOrder(id) : kind === "capture" ? pp.getCapture(id) : pp.getRefund(id)).catch((e) => ({ error: String(e) }));
  if (kind === "order") { const u = r.purchase_units?.[0]; console.log(arg, r.status ?? r.error, u?.amount?.value, u?.amount?.currency_code, (u?.payments?.captures ?? []).map((c: any) => `${c.id} ${c.status} ${c.amount.value}`).join(", ")); }
  else { const b = r.seller_receivable_breakdown ?? r.seller_payable_breakdown; console.log(arg, r.status ?? r.error, r.amount?.value, r.amount?.currency_code, b ? `fee ${b.paypal_fee?.value ?? b.paypal_fee?.value} net ${b.net_amount?.value} total_refunded ${b.total_refunded_amount?.value ?? "-"}` : ""); }
}
