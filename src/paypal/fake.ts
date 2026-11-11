import { randomBytes } from "node:crypto";
import { Balance, InvoiceInput, PayPalApi, PayPalError, PayPalInvoice, PayPalSubscription, PayPalTransaction, PlanInput, SearchedTransaction, SubscriptionInput } from "./types.js";

/**
 * In-memory PayPal used by the test suite. It models the subscription state machine closely enough
 * to exercise every Kept flow offline, including idempotent PayPal-Request-Id replays.
 * It is never used when real credentials are configured.
 */
export class FakePayPal implements PayPalApi {
  readonly env = "sandbox" as const;
  plans = new Map<string, PlanInput & { id: string }>();
  subs = new Map<string, PayPalSubscription & { history: PayPalTransaction[] }>();
  seenRequestIds = new Map<string, unknown>();
  calls: { method: string; args: unknown[] }[] = [];
  reviseNeedsConsent = false;
  failNext: string | null = null;
  invoices = new Map<string, PayPalInvoice & { input: InvoiceInput }>();

  private id(prefix: string) {
    return prefix + randomBytes(6).toString("hex").toUpperCase();
  }

  private idem<T>(requestId: string, fn: () => T): T {
    if (this.seenRequestIds.has(requestId)) return this.seenRequestIds.get(requestId) as T;
    const out = fn();
    this.seenRequestIds.set(requestId, out);
    return out;
  }

  private maybeFail(method: string) {
    if (this.failNext === method) {
      this.failNext = null;
      throw new PayPalError("Simulated PayPal failure", 422, "UNPROCESSABLE_ENTITY", "fake-debug", []);
    }
  }

  private sub(id: string) {
    const s = this.subs.get(id);
    if (!s) throw new PayPalError("The specified resource does not exist.", 404, "RESOURCE_NOT_FOUND", "fake", []);
    return s;
  }

  async verifyCredentials() {
    return { appId: "APP-FAKE", scopes: ["https://uri.paypal.com/services/subscriptions"] };
  }

  async createProduct(_input: { name: string; description: string }, requestId: string) {
    this.calls.push({ method: "createProduct", args: [_input] });
    return this.idem(requestId, () => ({ id: this.id("PROD-") }));
  }

  async createPlan(input: PlanInput, requestId: string) {
    this.calls.push({ method: "createPlan", args: [input] });
    return this.idem(requestId, () => {
      const id = this.id("P-");
      this.plans.set(id, { ...input, id });
      return { id, status: "ACTIVE" };
    });
  }

  async createSubscription(input: SubscriptionInput, requestId: string) {
    this.calls.push({ method: "createSubscription", args: [input] });
    this.maybeFail("createSubscription");
    return this.idem(requestId, () => {
      if (!this.plans.has(input.planId)) throw new PayPalError("Plan not found", 422, "INVALID_PLAN", "fake", []);
      const id = this.id("I-");
      this.subs.set(id, {
        id,
        status: "APPROVAL_PENDING",
        plan_id: input.planId,
        custom_id: input.customId,
        subscriber: { email_address: input.subscriberEmail },
        billing_info: { outstanding_balance: { value: "0.00", currency_code: "USD" }, failed_payments_count: 0 },
        links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=FAKE-${id}` }],
        history: [],
      });
      return { id, status: "APPROVAL_PENDING", approveUrl: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=FAKE-${id}` };
    });
  }

  /** Test helper: what the buyer does on PayPal's approval page. */
  approve(id: string, email = "buyer@example.com") {
    const s = this.sub(id);
    const plan = this.plans.get(s.plan_id)!;
    s.status = "ACTIVE";
    s.start_time = new Date().toISOString();
    s.subscriber = { ...s.subscriber, email_address: s.subscriber?.email_address ?? email, payer_id: "FAKEPAYER" };
    s.billing_info = {
      ...s.billing_info,
      next_billing_time: new Date(Date.now() + 30 * 864e5).toISOString(),
      last_payment: { amount: { value: plan.price, currency_code: plan.currency }, time: new Date().toISOString() },
    };
    s.history.push({ id: this.id("SALE-"), status: "COMPLETED", time: new Date().toISOString(), amount_with_breakdown: { gross_amount: { value: plan.price, currency_code: plan.currency } } });
  }

  /** Test helper: a renewal that fails. */
  failRenewal(id: string) {
    const s = this.sub(id);
    const plan = this.plans.get(s.plan_id)!;
    const out = Number(s.billing_info?.outstanding_balance?.value ?? 0) + Number(plan.price);
    s.billing_info = { ...s.billing_info, outstanding_balance: { value: out.toFixed(2), currency_code: plan.currency }, failed_payments_count: (s.billing_info?.failed_payments_count ?? 0) + 1 };
  }

  vault = new Map<string, { id: string; customerId: string; payerEmail: string }>();
  setupTokens = new Map<string, { id: string; approved: boolean }>();

  async getPaymentToken(id: string) {
    this.calls.push({ method: "getPaymentToken", args: [id] });
    const t = this.vault.get(id);
    return t ? { ...t, usageType: "MERCHANT" } : null;
  }

  async createSetupToken(_urls: { returnUrl: string; cancelUrl: string }, requestId: string) {
    return this.idem(requestId, () => {
      const id = this.id("ST-");
      this.setupTokens.set(id, { id, approved: false });
      return { id, status: "PAYER_ACTION_REQUIRED", approveUrl: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${id}` };
    });
  }

  async createPaymentToken(setupTokenId: string, requestId: string) {
    return this.idem(requestId, () => {
      const st = this.setupTokens.get(setupTokenId);
      if (!st?.approved) throw new PayPalError("Setup token not approved", 422, "UNPROCESSABLE_ENTITY", undefined, null);
      const t = { id: this.id("PT-"), customerId: this.id("C-"), payerEmail: "buyer@example.com" };
      this.vault.set(t.id, t);
      return t;
    });
  }

  async setSubscriptionCustomId(id: string, customId: string) {
    this.calls.push({ method: "setSubscriptionCustomId", args: [id, customId] });
    (this.sub(id) as any).custom_id = customId;
  }

  async getSubscription(id: string) {
    const { history, ...rest } = this.sub(id);
    return JSON.parse(JSON.stringify(rest)) as PayPalSubscription;
  }

  async reviseSubscription(id: string, planId: string, requestId: string) {
    this.calls.push({ method: "reviseSubscription", args: [id, planId] });
    return this.idem(requestId, () => {
      const s = this.sub(id);
      if (s.status !== "ACTIVE" && s.status !== "SUSPENDED") throw new PayPalError("Subscription status is invalid", 422, "SUBSCRIPTION_STATUS_INVALID", "fake", []);
      if (this.reviseNeedsConsent) return { approveUrl: `https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=FAKE-${id}`, planId };
      s.plan_id = planId;
      return { approveUrl: null, planId };
    });
  }

  async suspendSubscription(id: string, _reason: string, requestId: string) {
    this.calls.push({ method: "suspendSubscription", args: [id] });
    this.idem(requestId, () => {
      const s = this.sub(id);
      if (s.status !== "ACTIVE") throw new PayPalError("Subscription status is invalid", 422, "SUBSCRIPTION_STATUS_INVALID", "fake", []);
      s.status = "SUSPENDED";
      return true;
    });
  }

  async activateSubscription(id: string, _reason: string, requestId: string) {
    this.calls.push({ method: "activateSubscription", args: [id] });
    this.idem(requestId, () => {
      const s = this.sub(id);
      if (s.status !== "SUSPENDED") throw new PayPalError("Subscription status is invalid", 422, "SUBSCRIPTION_STATUS_INVALID", "fake", []);
      s.status = "ACTIVE";
      return true;
    });
  }

  async cancelSubscription(id: string, _reason: string, requestId: string) {
    this.calls.push({ method: "cancelSubscription", args: [id] });
    this.maybeFail("cancelSubscription");
    this.idem(requestId, () => {
      const s = this.sub(id);
      if (s.status === "CANCELLED") throw new PayPalError("Subscription status is invalid", 422, "SUBSCRIPTION_STATUS_INVALID", "fake", []);
      s.status = "CANCELLED";
      return true;
    });
  }

  async captureOutstanding(id: string, amount: string, currency: string, _note: string, requestId: string) {
    this.calls.push({ method: "captureOutstanding", args: [id, amount] });
    return this.idem(requestId, () => {
      const s = this.sub(id);
      const out = Number(s.billing_info?.outstanding_balance?.value ?? 0);
      if (out <= 0) throw new PayPalError("No outstanding balance", 422, "ZERO_OUTSTANDING_BALANCE", "fake", []);
      s.billing_info = { ...s.billing_info, outstanding_balance: { value: (out - Number(amount)).toFixed(2), currency_code: currency }, failed_payments_count: 0 };
      const sale = { id: this.id("SALE-"), status: "COMPLETED", time: new Date().toISOString(), amount_with_breakdown: { gross_amount: { value: amount, currency_code: currency } } };
      s.history.push(sale);
      return { status: "COMPLETED", id: sale.id };
    });
  }

  async listSubscriptionTransactions(id: string) {
    return [...this.sub(id).history];
  }

  refunds = new Map<string, { id: string; state: string; amount: string; saleId: string }>();
  async refundSale(saleId: string, amount: string, _currency: string, requestId: string) {
    return this.idem(requestId, () => {
      const r = { id: "REFUND-" + saleId, state: "completed", amount, saleId };
      this.refunds.set(r.id, r);
      return { id: r.id, state: r.state };
    });
  }

  async getRefund(refundId: string) {
    const r = this.refunds.get(refundId);
    if (!r) throw new Error(`no refund ${refundId}`);
    return { id: r.id, state: r.state, amount: r.amount };
  }

  async createWebhook() {
    return { id: "WH-FAKE" };
  }

  async listWebhooks() {
    return [];
  }

  async verifyWebhookSignature(headers: Record<string, string | undefined>) {
    return headers["paypal-transmission-sig"] === "valid-fake-signature";
  }

  async exchangeAuthCode() {
    return { access_token: "fake" };
  }

  async getUserInfo() {
    return { payer_id: "FAKEPAYER", email: "owner@example.com", name: "Demo Owner" };
  }

  /* ---- roadmap K5 additions ---- */

  async createInvoice(input: InvoiceInput, requestId: string) {
    this.calls.push({ method: "createInvoice", args: [input.amount, input.currency] });
    return this.idem(requestId, () => {
      const id = this.id("INV2-");
      const inv = { id, status: "DRAFT", detail: { reference: input.reference, currency_code: input.currency, invoice_number: id }, amount: { value: input.amount, currency_code: input.currency }, links: [{ rel: "self", href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}` }], input };
      this.invoices.set(id, inv);
      return inv;
    });
  }

  async sendInvoice(invoiceId: string, requestId: string) {
    this.calls.push({ method: "sendInvoice", args: [invoiceId] });
    return this.idem(requestId, () => {
      const inv = this.invoices.get(invoiceId);
      if (!inv) throw new PayPalError("Invoice not found", 404, "RESOURCE_NOT_FOUND", "fake", []);
      inv.status = "SENT";
      return { status: "SENT", href: `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}` };
    });
  }

  /** Test helper: the subscriber pays the invoice. */
  payInvoice(invoiceId: string) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error("no such invoice");
    inv.status = "PAID";
  }

  async getInvoice(invoiceId: string) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new PayPalError("Invoice not found", 404, "RESOURCE_NOT_FOUND", "fake", []);
    const { input, ...rest } = inv;
    return JSON.parse(JSON.stringify(rest)) as PayPalInvoice;
  }

  async searchTransactions(startIso: string, endIso: string): Promise<SearchedTransaction[]> {
    const out: SearchedTransaction[] = [];
    for (const s of this.subs.values()) for (const h of s.history) {
      if (h.time >= startIso && h.time <= endIso) out.push({ transaction_id: h.id, transaction_status: h.status === "COMPLETED" ? "S" : "P", transaction_amount: h.amount_with_breakdown!.gross_amount, transaction_initiation_date: h.time, transaction_event_code: "T0002", paypal_reference_id: s.id, payer_email: s.subscriber?.email_address });
    }
    return out;
  }

  async listBalances(): Promise<Balance[]> {
    let total = 0;
    for (const s of this.subs.values()) for (const h of s.history) if (h.status === "COMPLETED") total += Number(h.amount_with_breakdown!.gross_amount.value);
    return [{ currency: "USD", total: total.toFixed(2), available: total.toFixed(2), withheld: "0.00" }];
  }


}
