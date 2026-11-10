import { randomBytes } from "node:crypto";

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
const num = (v: string | undefined, dflt: number) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? dflt : Number(v));

const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, ""),
  databaseUrl: process.env.DATABASE_URL || "",
  pglitePath: process.env.PGLITE_PATH || "./data/pglite",
  paypal: {
    env: (process.env.PAYPAL_ENV || "sandbox") as "sandbox" | "live",
    clientId: process.env.PAYPAL_CLIENT_ID || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
    loginEnabled: bool(process.env.PAYPAL_LOGIN_ENABLED, false),
    /** A2.1: the saved demo wallet (Vault v3 payment token, usage MERCHANT), shared by the eight hackathon apps. */
    demoVaultToken: process.env.PAYPAL_DEMO_VAULT_TOKEN || "",
    demoBuyerEmail: process.env.PAYPAL_DEMO_BUYER_EMAIL || "",
  },
  /** Admin key: the showcase shop, the approval pool, the wallet re-approval and global switches. Never shown to visitors. */
  adminKey: process.env.KEPT_ADMIN_KEY || "",
  /** The commit this build runs (Render sets RENDER_GIT_COMMIT). Shown by /healthz. */
  commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "",
  production: process.env.NODE_ENV === "production",
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  /** "openai" uses the model brain (with the local brain as its fallback); "local" never calls a model. */
  brain: (process.env.KEPT_BRAIN || (process.env.OPENAI_API_KEY ? "openai" : "local")) as "local" | "openai",
  demoMode: bool(process.env.KEPT_DEMO_MODE, true),
  inlineWorker: bool(process.env.KEPT_INLINE_WORKER, true),
  workerIntervalMs: Number(process.env.KEPT_WORKER_INTERVAL_MS ?? 5000),
  /* ---- foundation (roadmap B) ---- */
  ai: {
    provider: (process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "rules")) as "openai" | "rules",
    openaiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, ""),
    models: {
      read: process.env.AI_MODEL_READ || "gpt-5.5",
      classify: process.env.AI_MODEL_CLASSIFY || "gpt-5.4-mini",
      vision: process.env.AI_MODEL_VISION || "gpt-5.6-luna",
    },
  },
  channels: {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
    telegramBot: process.env.TELEGRAM_BOT_USERNAME || "paypalhackathonbot",
    whatsappToken: process.env.WHATSAPP_TOKEN || "",
    whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || "",
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "kept-verify",
    vapidPublic: process.env.VAPID_PUBLIC_KEY || "",
    vapidPrivate: process.env.VAPID_PRIVATE_KEY || "",
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || "",
      authToken: process.env.TWILIO_AUTH_TOKEN || "",
      apiKeySid: process.env.TWILIO_API_KEY_SID || process.env.TWILIO_API_KEY || "",
      apiKeySecret: process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_API_SECRET || "",
      from: process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER || "",
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || "",
    },
  },
  guard: {
    /** Owner approvals of money moves above this need a passkey countersign when one is registered. */
    countersignAboveCents: num(process.env.KEPT_COUNTERSIGN_ABOVE_CENTS, 20000),
  },
};

export function paypalBaseUrl(env: "sandbox" | "live" = config.paypal.env): string {
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}
