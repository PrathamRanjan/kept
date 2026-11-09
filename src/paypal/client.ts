import { paypalBaseUrl } from "../config.js";
import { Balance, InvoiceInput, PayPalApi, PayPalError, PayPalInvoice, PayPalSubscription, PayPalTransaction, PlanInput, SearchedTransaction, SubscriptionInput } from "./types.js";

interface Creds {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "live";
}

type Json = Record<string, unknown>;

/**
 * Thin, typed PayPal REST client. Every write takes a PayPal-Request-Id so retries are idempotent at PayPal.
 * Only the executor (src/executor.ts) is allowed to call the write methods.
 */
export class PayPalClient implements PayPalApi {
  private token: { value: string; expiresAt: number; scopes: string[]; appId?: string } | null = null;
  private mockNext: string | null = null;
  readonly env: "sandbox" | "live";

  constructor(private readonly creds: Creds, private readonly fetchImpl: typeof fetch = fetch) {
    this.env = creds.env;
  }

  private get base() {
    return paypalBaseUrl(this.env);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new PayPalError(String(data.error_description ?? "PayPal authentication failed"), res.status, String(data.error ?? ""), undefined, data);
    this.token = {
      value: String(data.access_token),
      expiresAt: Date.now() + Number(data.expires_in ?? 3000) * 1000,
      scopes: String(data.scope ?? "").split(" ").filter(Boolean),
      appId: data.app_id ? String(data.app_id) : undefined,
    };
    return this.token.value;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown, opts: { requestId?: string; prefer?: string; allow404?: boolean } = {}): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    if (opts.prefer) headers["Prefer"] = opts.prefer;
    if (this.mockNext && method !== "GET" && this.env === "sandbox") {
      headers["PayPal-Mock-Response"] = JSON.stringify({ mock_application_codes: this.mockNext });
      this.mockNext = null;
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        const data = (text ? JSON.parse(text) : {}) as any;
        if (res.status >= 500 && attempt < 2) {
          lastErr = new PayPalError(data.message ?? `PayPal ${res.status}`, res.status, data.name, data.debug_id, data.details);
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue; // same PayPal-Request-Id, so a retry cannot double-apply
        }
        // PayPal still working on this request id ("request in progress") or rate limiting: the outcome is
        // unknown, never a refusal. Wait and resend the same request id; if it persists, report it as unknown.
        if (res.status === 429 || /PREVIOUS_REQUEST_IN_PROGRESS/.test(`${data.name ?? ""} ${JSON.stringify(data.details ?? "")}`)) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          throw new Error(`PayPal is still processing ${method} ${path} (outcome unknown; retry with the same request id)`);
        }
        if (!res.ok) {
          const detail = Array.isArray(data.details) && data.details[0] ? `: ${data.details[0].issue ?? ""} ${data.details[0].description ?? ""}`.trim() : "";
          throw new PayPalError(`${data.message ?? data.name ?? `PayPal ${res.status}`}${detail}`, res.status, data.name, data.debug_id, data.details);
        }
        return { status: res.status, data: data as T };
      } catch (e) {
        if (e instanceof PayPalError) throw e;
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async verifyCredentials() {
    await this.accessToken();
    return { appId: this.token?.appId, scopes: this.token?.scopes ?? [] };
  }

  async createProduct(input: { name: string; description: string }, requestId: string) {
    const { data } = await this.call<{ id: string }>("POST", "/v1/catalogs/products", {
      name: input.name.slice(0, 127),
      description: input.description.slice(0, 256) || undefined,
      type: "SERVICE",
    }, { requestId });
    return { id: data.id };
  }

  async createPlan(input: PlanInput, requestId: string) {
    const { data } = await this.call<{ id: string; status: string }>("POST", "/v1/billing/plans", {
      product_id: input.productId,
      name: input.name.slice(0, 127),
      description: input.description.slice(0, 127) || input.name.slice(0, 127),
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: input.intervalUnit, interval_count: input.intervalCount },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: input.price, currency_code: input.currency } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 3 },
    }, { requestId, prefer: "return=representation" });
    return { id: data.id, status: data.status };
  }

  async createSubscription(input: SubscriptionInput, requestId: string) {
    const subscriber: Json = {};
    if (input.subscriberEmail) subscriber.email_address = input.subscriberEmail;
    if (input.subscriberName) {
      const [given, ...rest] = input.subscriberName.trim().split(/\s+/);
      subscriber.name = { given_name: given, surname: rest.join(" ") || undefined };
    }
    const { data } = await this.call<PayPalSubscription>("POST", "/v1/billing/subscriptions", {
      plan_id: input.planId,
      custom_id: input.customId,
      subscriber: Object.keys(subscriber).length ? subscriber : undefined,
      application_context: {
        brand_name: input.brandName.slice(0, 127),
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
      },
    }, { requestId, prefer: "return=representation" });
    const approve = data.links?.find((l) => l.rel === "approve")?.href ?? null;
    return { id: data.id, status: data.status, approveUrl: approve };
  }

  async getSubscription(id: string) {
    const { data } = await this.call<PayPalSubscription>("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
    return data;
  }

  async reviseSubscription(id: string, planId: string, requestId: string, urls: { returnUrl: string; cancelUrl: string }) {
    const { data } = await this.call<{ plan_id: string; links?: { rel: string; href: string }[] }>("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/revise`, {
      plan_id: planId,
      application_context: { return_url: urls.returnUrl, cancel_url: urls.cancelUrl, user_action: "CONTINUE", shipping_preference: "NO_SHIPPING" },
    }, { requestId });
    return { approveUrl: data.links?.find((l) => l.rel === "approve")?.href ?? null, planId: data.plan_id ?? planId };
  }

  async suspendSubscription(id: string, reason: string, requestId: string) {
    await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/suspend`, { reason: reason.slice(0, 128) }, { requestId });
  }

  async activateSubscription(id: string, reason: string, requestId: string) {
    await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/activate`, { reason: reason.slice(0, 128) }, { requestId });
  }

  async cancelSubscription(id: string, reason: string, requestId: string) {
    await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 128) || "Cancelled by subscriber" }, { requestId });
  }

  async captureOutstanding(id: string, amount: string, currency: string, note: string, requestId: string) {
    const { data } = await this.call<{ status?: string; id?: string }>("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/capture`, {
      note: note.slice(0, 128),
      capture_type: "OUTSTANDING_BALANCE",
      amount: { currency_code: currency, value: amount },
    }, { requestId });
    return data;
  }

  async listSubscriptionTransactions(id: string, startIso: string, endIso: string) {
    const q = new URLSearchParams({ start_time: startIso, end_time: endIso });
    const { data } = await this.call<{ transactions?: PayPalTransaction[] }>("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}/transactions?${q}`);
    return data.transactions ?? [];
  }

  async refundSale(saleId: string, amount: string, currency: string, requestId: string) {
    const { data } = await this.call<{ id: string; state: string }>("POST", `/v1/payments/sale/${encodeURIComponent(saleId)}/refund`, {
      amount: { total: amount, currency },
    }, { requestId });
    return data;
  }

  async createWebhook(url: string, eventTypes: string[]) {
    const { data } = await this.call<{ id: string }>("POST", "/v1/notifications/webhooks", {
      url,
      event_types: eventTypes.map((name) => ({ name })),
    });
    return { id: data.id };
  }

  async listWebhooks() {
    const { data } = await this.call<{ webhooks: { id: string; url: string; event_types: { name: string }[] }[] }>("GET", "/v1/notifications/webhooks");
    return data.webhooks ?? [];
  }

  async verifyWebhookSignature(headers: Record<string, string | undefined>, body: unknown, webhookId: string) {
    const { data } = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: body,
    });
    return data.verification_status === "SUCCESS";
  }

  async exchangeAuthCode(code: string) {
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    const data = (await res.json()) as Json;
    if (!res.ok) throw new PayPalError("Log in with PayPal failed", res.status, String(data.error ?? ""), undefined, data);
    return { access_token: String(data.access_token) };
  }

  async getUserInfo(accessToken: string) {
    const res = await this.fetchImpl(`${this.base}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = (await res.json()) as any;
    if (!res.ok) throw new PayPalError("Could not read PayPal user info", res.status, data.name, data.debug_id, data);
    const email = Array.isArray(data.emails) ? (data.emails.find((e: any) => e.primary)?.value ?? data.emails[0]?.value) : data.email;
    return { payer_id: data.payer_id ?? data.user_id, email, name: data.name };
  }

  /* ---- roadmap K5 additions ---- */

  async createInvoice(input: InvoiceInput, requestId: string) {
    const { data } = await this.call<PayPalInvoice>("POST", "/v2/invoicing/invoices", {
      detail: { currency_code: input.currency, reference: input.reference.slice(0, 120), note: input.note.slice(0, 4000), payment_term: { term_type: "DUE_ON_RECEIPT" } },
      invoicer: { business_name: input.merchantName.slice(0, 300), email_address: input.merchantEmail ?? undefined },
      primary_recipients: input.recipientEmail ? [{ billing_info: { email_address: input.recipientEmail, name: input.recipientName ? { given_name: input.recipientName.split(" ")[0], surname: input.recipientName.split(" ").slice(1).join(" ") || undefined } : undefined } }] : undefined,
      items: [{ name: "Outstanding subscription renewal", quantity: "1", unit_amount: { currency_code: input.currency, value: input.amount } }],
    }, { requestId, prefer: "return=representation" });
    return data;
  }

  async sendInvoice(invoiceId: string, requestId: string) {
    const { data, status } = await this.call<{ href?: string }>("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, { send_to_recipient: true, send_to_invoicer: false }, { requestId });
    return { status: status === 202 ? "SCHEDULED" : "SENT", href: data.href ?? null };
  }

  async getInvoice(invoiceId: string) {
    const { data } = await this.call<PayPalInvoice>("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    return data;
  }

  async searchTransactions(startIso: string, endIso: string) {
    const q = new URLSearchParams({ start_date: startIso, end_date: endIso, fields: "transaction_info,payer_info", page_size: "100" });
    const { data } = await this.call<{ transaction_details?: { transaction_info: any; payer_info?: any }[] }>("GET", `/v1/reporting/transactions?${q}`);
    return (data.transaction_details ?? []).map((t) => ({
      transaction_id: t.transaction_info.transaction_id,
      transaction_status: t.transaction_info.transaction_status,
      transaction_amount: t.transaction_info.transaction_amount,
      transaction_initiation_date: t.transaction_info.transaction_initiation_date,
      transaction_event_code: t.transaction_info.transaction_event_code,
      paypal_reference_id: t.transaction_info.paypal_reference_id,
      payer_email: t.payer_info?.email_address,
    })) as SearchedTransaction[];
  }

  async listBalances(): Promise<Balance[]> {
    const { data } = await this.call<{ balances?: { currency: string; total_balance?: { value: string }; available_balance?: { value: string }; withheld_balance?: { value: string } }[] }>("GET", "/v1/reporting/balances");
    return (data.balances ?? []).map((b) => ({ currency: b.currency, total: b.total_balance?.value ?? "0.00", available: b.available_balance?.value ?? "0.00", withheld: b.withheld_balance?.value ?? "0.00" }));
  }

  async simulateWebhookEvent(webhookId: string, eventType: string) {
    const { data } = await this.call<{ id: string }>("POST", "/v1/notifications/simulate-event", { webhook_id: webhookId, event_type: eventType });
    return { id: data.id };
  }

  withMockResponse(code: string) {
    this.mockNext = code.replace(/[^A-Z0-9_]/gi, "").slice(0, 40);
  }
}

export const WEBHOOK_EVENTS = [
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED",
  "PAYMENT.SALE.COMPLETED",
  "PAYMENT.SALE.REFUNDED",
  "PAYMENT.SALE.REVERSED",
];
