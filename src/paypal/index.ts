import { config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { PayPalClient } from "./client.js";
import type { PayPalApi } from "./types.js";

export interface MerchantCreds {
  id: string;
  paypal_env: string;
  paypal_credentials: string | null;
}

type Factory = (m: MerchantCreds | null) => PayPalApi;

const cache = new Map<string, PayPalApi>();

const defaultFactory: Factory = (m) => {
  const key = m?.paypal_credentials ? `m:${m.id}` : "env";
  const hit = cache.get(key);
  if (hit) return hit;
  let clientId = config.paypal.clientId;
  let clientSecret = config.paypal.clientSecret;
  let env = config.paypal.env;
  if (m?.paypal_credentials) {
    const c = JSON.parse(decrypt(m.paypal_credentials)) as { clientId: string; clientSecret: string };
    clientId = c.clientId;
    clientSecret = c.clientSecret;
    env = (m.paypal_env as "sandbox" | "live") || "sandbox";
  }
  if (!clientId || !clientSecret) throw new Error("PayPal credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or connect a PayPal app during onboarding.");
  const client = new PayPalClient({ clientId, clientSecret, env });
  cache.set(key, client);
  return client;
};

let factory: Factory = defaultFactory;

export function paypalFor(m: MerchantCreds | null): PayPalApi {
  const api = factory(m);
  return api;
}

/** Tests swap in FakePayPal here. */
export function setPayPalFactory(f: Factory | null) {
  factory = f ?? defaultFactory;
  cache.clear();
}

export function forgetPayPalClient(merchantId: string) {
  cache.delete(`m:${merchantId}`);
}

export { PayPalClient } from "./client.js";
export * from "./types.js";
