export type IntervalUnit = "DAY" | "WEEK" | "MONTH" | "YEAR";

export interface PlanInput {
  productId: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  intervalUnit: IntervalUnit;
  intervalCount: number;
}

export interface SubscriptionInput {
  planId: string;
  customId: string;
  brandName: string;
  returnUrl: string;
  cancelUrl: string;
  subscriberEmail?: string;
  subscriberName?: string;
  /** PayPal's approval page language (BCP 47, e.g. pt-BR). Left out, PayPal picks from the buyer's browser. */
  locale?: string;
}

/** The subset of a PayPal subscription Kept relies on. */
export interface PayPalSubscription {
  id: string;
  status: "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
  plan_id: string;
  custom_id?: string;
  start_time?: string;
  status_update_time?: string;
  subscriber?: { email_address?: string; name?: { given_name?: string; surname?: string }; payer_id?: string };
  billing_info?: {
    outstanding_balance?: { value: string; currency_code: string };
    next_billing_time?: string;
    last_payment?: { amount: { value: string; currency_code: string }; time: string };
    failed_payments_count?: number;
    cycle_executions?: { tenure_type: string; cycles_completed: number }[];
  };
  links?: { href: string; rel: string; method?: string }[];
}

export interface PayPalTransaction {
  id: string;
  status: string;
  amount_with_breakdown?: { gross_amount: { value: string; currency_code: string }; net_amount?: { value: string } };
  time: string;
}

export interface InvoiceInput {
  recipientEmail: string | null;
  recipientName: string | null;
  merchantName: string;
  merchantEmail: string | null;
  amount: string;
  currency: string;
  note: string;
  reference: string;
}
export interface PayPalInvoice {
  id: string;
  status: string;
  detail?: { invoice_number?: string; reference?: string; currency_code?: string };
  amount?: { value: string; currency_code: string };
  links?: { href: string; rel: string; method?: string }[];
}
export interface SearchedTransaction {
  transaction_id: string;
  transaction_status: string;
  transaction_amount: { value: string; currency_code: string };
  transaction_initiation_date: string;
  transaction_event_code?: string;
  paypal_reference_id?: string;
  payer_email?: string;
}
export interface Balance {
  currency: string;
  total: string;
  available: string;
  withheld: string;
}

export interface PayPalApi {
  readonly env: "sandbox" | "live";
  verifyCredentials(): Promise<{ appId?: string; scopes: string[] }>;
  createProduct(input: { name: string; description: string }, requestId: string): Promise<{ id: string }>;
  createPlan(input: PlanInput, requestId: string): Promise<{ id: string; status: string }>;
  createSubscription(input: SubscriptionInput, requestId: string): Promise<{ id: string; status: string; approveUrl: string | null }>;
  getSubscription(id: string): Promise<PayPalSubscription>;
  reviseSubscription(id: string, planId: string, requestId: string, urls: { returnUrl: string; cancelUrl: string }): Promise<{ approveUrl: string | null; planId: string }>;
  suspendSubscription(id: string, reason: string, requestId: string): Promise<void>;
  activateSubscription(id: string, reason: string, requestId: string): Promise<void>;
  cancelSubscription(id: string, reason: string, requestId: string): Promise<void>;
  captureOutstanding(id: string, amount: string, currency: string, note: string, requestId: string): Promise<{ status?: string; id?: string }>;
  listSubscriptionTransactions(id: string, startIso: string, endIso: string): Promise<PayPalTransaction[]>;
  refundSale(saleId: string, amount: string, currency: string, requestId: string): Promise<{ id: string; state: string }>;
  getRefund(refundId: string): Promise<{ id: string; state: string; amount?: string }>;
  createWebhook(url: string, eventTypes: string[]): Promise<{ id: string }>;
  listWebhooks(): Promise<{ id: string; url: string; event_types: { name: string }[] }[]>;
  verifyWebhookSignature(headers: Record<string, string | undefined>, body: unknown, webhookId: string): Promise<boolean>;
  getUserInfo(accessToken: string): Promise<{ payer_id?: string; email?: string; name?: string }>;
  exchangeAuthCode(code: string): Promise<{ access_token: string }>;
  /* ---- roadmap K5 additions ---- */
  /** Invoicing v2: create a draft invoice for an outstanding balance (alternative to capture after a failed renewal). */
  createInvoice(input: InvoiceInput, requestId: string): Promise<PayPalInvoice>;
  /** Invoicing v2: send the invoice to the recipient (PayPal emails it). */
  sendInvoice(invoiceId: string, requestId: string): Promise<{ status: string; href: string | null }>;
  getInvoice(invoiceId: string): Promise<PayPalInvoice>;
  /** Transaction Search (reporting): the merchant's transactions in a window, read-only. */
  searchTransactions(startIso: string, endIso: string): Promise<SearchedTransaction[]>;
  /** Reporting: balances including withheld. */
  listBalances(): Promise<Balance[]>;
  /* ---- Wave 1 (A2.1 saved demo wallet, A2.2 approval pool, A1 workspace routing) ---- */
  /** Vault v3: read a saved payment token (the demo wallet health check). Returns null when PayPal no longer has it. */
  getPaymentToken(id: string): Promise<{ id: string; customerId: string | null; payerEmail: string | null; usageType: string | null } | null>;
  /** Vault v3: start a buyer approval to save their PayPal for merchant use (usage_type MERCHANT). */
  createSetupToken(urls: { returnUrl: string; cancelUrl: string }, requestId: string): Promise<{ id: string; status: string; approveUrl: string | null }>;
  /** Vault v3: turn an approved setup token into a payment token. */
  createPaymentToken(setupTokenId: string, requestId: string): Promise<{ id: string; customerId: string | null; payerEmail: string | null }>;
  /** Subscriptions: replace custom_id (used to tag a pool subscription with the workspace that claimed it). */
  setSubscriptionCustomId(id: string, customId: string): Promise<void>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly name_: string | undefined,
    readonly debugId: string | undefined,
    readonly details: unknown,
  ) {
    super(message);
  }
  get isClientError() {
    return this.status >= 400 && this.status < 500;
  }
}
