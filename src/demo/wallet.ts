/**
 * A2.1 The saved demo wallet: one sandbox buyer's PayPal, saved once with Vault v3 (usage_type MERCHANT) and shared
 * by the hackathon apps. Kept checks it daily and lets the admin re-approve it if PayPal ever removes it.
 *
 * What it can and cannot do in Kept (probed on the sandbox, 10 Nov 2026): PayPal Subscriptions do not accept a
 * vaulted wallet. A subscription created with payment_source.paypal.vault_id, or with
 * subscriber.payment_source.token, still comes back APPROVAL_PENDING with an approve link. So Kept's real members
 * come from the approval pool (src/demo/pool.ts), approved ahead of time by the owner, never from the wallet.
 */
import { config } from "../config.js";
import { getDb } from "../db.js";
import { paypalFor } from "../paypal/index.js";

const KEY = "demo_wallet";
const HEALTH = "demo_wallet_health";

export interface WalletHealth { ok: boolean; checkedAt: string; token: string | null; buyerEmail: string | null; detail: string }

async function getSetting(key: string): Promise<string | null> {
  return (await (await getDb()).query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key])).rows[0]?.value ?? null;
}
async function putSetting(key: string, value: string) {
  await (await getDb()).query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
}

/** The token in use: a re-approval saved through the admin page wins over the PAYPAL_DEMO_VAULT_TOKEN setting. */
export async function walletToken(): Promise<{ token: string | null; buyerEmail: string | null; source: "admin" | "setting" | "none" }> {
  const saved = await getSetting(KEY);
  if (saved) {
    const v = JSON.parse(saved) as { token: string; buyerEmail: string | null };
    if (v.token) return { token: v.token, buyerEmail: v.buyerEmail ?? null, source: "admin" };
  }
  if (config.paypal.demoVaultToken) return { token: config.paypal.demoVaultToken, buyerEmail: config.paypal.demoBuyerEmail || null, source: "setting" };
  return { token: null, buyerEmail: null, source: "none" };
}

/** Reads the token from PayPal (GET /v3/vault/payment-tokens/{id}) and stores the result. */
export async function checkWallet(): Promise<WalletHealth> {
  const w = await walletToken();
  let h: WalletHealth;
  if (!w.token) h = { ok: false, checkedAt: new Date().toISOString(), token: null, buyerEmail: null, detail: "No saved wallet: set PAYPAL_DEMO_VAULT_TOKEN or re-approve on the admin page." };
  else {
    try {
      const t = await paypalFor(null).getPaymentToken(w.token);
      h = t
        ? { ok: true, checkedAt: new Date().toISOString(), token: mask(w.token), buyerEmail: t.payerEmail ?? w.buyerEmail, detail: `PayPal has the token (usage ${t.usageType ?? "unknown"}).` }
        : { ok: false, checkedAt: new Date().toISOString(), token: mask(w.token), buyerEmail: w.buyerEmail, detail: "PayPal no longer has this token: the saved wallet needs re-approval." };
    } catch (e) {
      h = { ok: false, checkedAt: new Date().toISOString(), token: mask(w.token), buyerEmail: w.buyerEmail, detail: `Could not read the token from PayPal: ${(e as Error).message.slice(0, 160)}` };
    }
  }
  await putSetting(HEALTH, JSON.stringify(h));
  return h;
}

export async function lastWalletHealth(): Promise<WalletHealth | null> {
  const v = await getSetting(HEALTH);
  return v ? (JSON.parse(v) as WalletHealth) : null;
}

/** Admin re-approval, step 1: a setup token and PayPal's approve link. */
export async function startWalletApproval(): Promise<string> {
  const st = await paypalFor(null).createSetupToken({ returnUrl: `${config.appUrl}/admin/paypal/wallet/return`, cancelUrl: `${config.appUrl}/admin/paypal/wallet?err=Approval%20cancelled` }, `wallet-setup-${Date.now()}`);
  if (!st.approveUrl) throw new Error("PayPal returned no approve link for the setup token.");
  await putSetting("demo_wallet_setup", JSON.stringify({ id: st.id, at: new Date().toISOString() }));
  return st.approveUrl;
}

/** Admin re-approval, step 2: exchange the approved setup token, then read the new token back before saving it. */
export async function finishWalletApproval(setupTokenId: string): Promise<WalletHealth> {
  const pending = await getSetting("demo_wallet_setup");
  if (!pending || (JSON.parse(pending) as { id: string }).id !== setupTokenId) throw new Error("That setup token was not started from this page.");
  const pt = await paypalFor(null).createPaymentToken(setupTokenId, `wallet-token-${setupTokenId}`);
  const back = await paypalFor(null).getPaymentToken(pt.id);
  if (!back) throw new Error("PayPal did not return the new payment token on read-back.");
  await putSetting(KEY, JSON.stringify({ token: pt.id, buyerEmail: back.payerEmail ?? pt.payerEmail, savedAt: new Date().toISOString() }));
  return checkWallet();
}

export const mask = (t: string) => (t.length > 6 ? `${t.slice(0, 3)}…${t.slice(-3)}` : "…");
