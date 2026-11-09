/** Registers (or finds) the PayPal webhook for APP_URL/webhooks/paypal on the env PayPal app and prints its id. */
import { config } from "../src/config.js";
import { paypalFor } from "../src/paypal/index.js";
import { WEBHOOK_EVENTS } from "../src/paypal/client.js";

(async () => {
  if (!config.appUrl.startsWith("https://")) throw new Error(`APP_URL must be a public https URL (got ${config.appUrl}).`);
  const pp = paypalFor(null);
  const url = `${config.appUrl}/webhooks/paypal`;
  const existing = (await pp.listWebhooks()).find((w) => w.url === url);
  const id = existing?.id ?? (await pp.createWebhook(url, WEBHOOK_EVENTS)).id;
  console.log(`${existing ? "Found" : "Created"} webhook ${id} for ${url}\nSet PAYPAL_WEBHOOK_ID=${id}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
