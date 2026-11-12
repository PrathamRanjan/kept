import type { Queryable } from "./db.js";
import type { PlanLite } from "./policy/eligibility.js";
import type { Rules } from "./policy/rules.js";

export class KeptError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400, readonly data?: unknown) {
    super(message);
  }
}

export interface Merchant {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  currency: string;
  owner_email: string | null;
  paypal_payer_id: string | null;
  paypal_env: string;
  paypal_credentials: string | null;
  paypal_product_id: string | null;
  paypal_webhook_id?: string | null;
  owner_token: string;
  created_at: Date;
}

export interface Plan extends Omit<PlanLite, "price"> {
  merchant_id: string;
  paypal_plan_id: string | null;
  description: string;
  price: number;
  created_at: Date;
}

export interface Subscriber {
  id: string;
  merchant_id: string;
  plan_id: string | null;
  home_plan_id: string | null;
  ref: string;
  paypal_subscription_id: string | null;
  /** Set while a cancellation is requested and PayPal hasn't confirmed it; cleared once it has. */
  cancel_requested_at?: Date | string | null;
  status: string;
  kept_state: string | null;
  subscriber_name: string | null;
  subscriber_email: string | null;
  /** The member's language for words Kept sends them (en, hi-IN, id-ID, pt-BR); null means English. */
  lang?: string | null;
  channel: string;
  agent_id: string | null;
  approval_url: string | null;
  next_billing_time: Date | null;
  last_payment_amount: number | null;
  last_payment_time: Date | null;
  outstanding: number;
  failed_payments: number;
  resume_at: Date | null;
  promo_until: Date | null;
  is_sample: boolean;
  started_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Policy {
  id: string;
  merchant_id: string;
  version: number;
  rules: Rules;
  source_text: string;
  notes: string[];
  approved_at: Date | null;
}

export interface Offer {
  id: string;
  subscriber_id: string;
  merchant_id: string;
  policy_version: number;
  type: string;
  terms: Record<string, any>;
  message: string;
  reason_category: string | null;
  status: "open" | "accepted" | "declined" | "expired";
  monthly_value: number;
  expires_at: Date;
  decided_at: Date | null;
  created_at: Date;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function toPlan(r: any): Plan {
  return { ...r, price: Number(r.price), discount_percent: n(r.discount_percent) };
}

export function toSubscriber(r: any): Subscriber {
  return { ...r, outstanding: Number(r.outstanding ?? 0), last_payment_amount: n(r.last_payment_amount) };
}

export function toOffer(r: any): Offer {
  return { ...r, monthly_value: Number(r.monthly_value ?? 0) };
}

export async function merchantBySlug(q: Queryable, slug: string): Promise<Merchant | null> {
  return (await q.query<Merchant>("SELECT * FROM merchants WHERE slug = $1", [slug])).rows[0] ?? null;
}

export async function merchantById(q: Queryable, id: string): Promise<Merchant | null> {
  return (await q.query<Merchant>("SELECT * FROM merchants WHERE id = $1", [id])).rows[0] ?? null;
}

export async function merchantByToken(q: Queryable, token: string): Promise<Merchant | null> {
  return (await q.query<Merchant>("SELECT * FROM merchants WHERE owner_token = $1", [token])).rows[0] ?? null;
}

export async function listMerchants(q: Queryable): Promise<Merchant[]> {
  return (await q.query<Merchant>("SELECT * FROM merchants ORDER BY created_at")).rows;
}

/** Shops a stranger may discover (directory, find_shops, llms.txt): private visitor workspaces are left out. */
export async function listPublicMerchants(q: Queryable): Promise<Merchant[]> {
  return (await q.query<Merchant>("SELECT * FROM merchants WHERE id NOT IN (SELECT tenant_id FROM workspaces WHERE kind = 'visitor') ORDER BY created_at")).rows;
}

export async function plansFor(q: Queryable, merchantId: string, includeInactive = false): Promise<Plan[]> {
  const r = await q.query("SELECT * FROM plans WHERE merchant_id = $1" + (includeInactive ? "" : " AND active") + " ORDER BY kind DESC, price DESC", [merchantId]);
  return r.rows.map(toPlan);
}

export async function planById(q: Queryable, id: string): Promise<Plan | null> {
  const r = await q.query("SELECT * FROM plans WHERE id = $1", [id]);
  return r.rows[0] ? toPlan(r.rows[0]) : null;
}

/** A PayPal plan id is shared by every demo workspace cloned from the showcase, so the lookup is per shop. */
export async function planByPayPalId(q: Queryable, merchantId: string, ppId: string): Promise<Plan | null> {
  const r = await q.query("SELECT * FROM plans WHERE merchant_id = $1 AND paypal_plan_id = $2", [merchantId, ppId]);
  return r.rows[0] ? toPlan(r.rows[0]) : null;
}

export async function currentPolicy(q: Queryable, merchantId: string): Promise<Policy | null> {
  const r = await q.query<Policy>("SELECT * FROM policies WHERE merchant_id = $1 AND approved_at IS NOT NULL ORDER BY version DESC LIMIT 1", [merchantId]);
  return r.rows[0] ?? null;
}

export async function subscriberByRef(q: Queryable, ref: string): Promise<Subscriber | null> {
  const r = await q.query("SELECT * FROM subscribers WHERE ref = $1", [ref]);
  return r.rows[0] ? toSubscriber(r.rows[0]) : null;
}

export async function subscriberById(q: Queryable, id: string): Promise<Subscriber | null> {
  const r = await q.query("SELECT * FROM subscribers WHERE id = $1", [id]);
  return r.rows[0] ? toSubscriber(r.rows[0]) : null;
}

export async function subscriberByPayPalId(q: Queryable, ppId: string): Promise<Subscriber | null> {
  const r = await q.query("SELECT * FROM subscribers WHERE paypal_subscription_id = $1", [ppId]);
  return r.rows[0] ? toSubscriber(r.rows[0]) : null;
}

export async function subscribersFor(q: Queryable, merchantId: string): Promise<Subscriber[]> {
  const r = await q.query("SELECT * FROM subscribers WHERE merchant_id = $1 ORDER BY created_at DESC", [merchantId]);
  return r.rows.map(toSubscriber);
}

export async function openOfferFor(q: Queryable, subscriberId: string): Promise<Offer | null> {
  const r = await q.query("SELECT * FROM offers WHERE subscriber_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1", [subscriberId]);
  return r.rows[0] ? toOffer(r.rows[0]) : null;
}

export async function offerById(q: Queryable, id: string): Promise<Offer | null> {
  const r = await q.query("SELECT * FROM offers WHERE id = $1", [id]);
  return r.rows[0] ? toOffer(r.rows[0]) : null;
}

export async function logEvent(
  q: Queryable,
  e: { merchantId?: string | null; subscriberId?: string | null; source: string; type: string; summary: string; payload?: unknown; paypal?: unknown; sample?: boolean },
) {
  await q.query(
    "INSERT INTO event_log (merchant_id, subscriber_id, source, type, summary, payload, paypal_response, is_sample) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [e.merchantId ?? null, e.subscriberId ?? null, e.source, e.type, e.summary, e.payload === undefined ? null : JSON.stringify(e.payload), e.paypal === undefined ? null : JSON.stringify(e.paypal), e.sample ?? false],
  );
}

export async function updateSubscriber(q: Queryable, id: string, fields: Partial<Record<keyof Subscriber, unknown>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q.query(`UPDATE subscribers SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (fields as any)[k])]);
}

export function intervalMs(p: { interval_unit: string; interval_count: number }): number {
  const day = 864e5;
  const per = p.interval_unit === "DAY" ? day : p.interval_unit === "WEEK" ? 7 * day : p.interval_unit === "MONTH" ? 30 * day : 365 * day;
  return per * p.interval_count;
}

export function intervalWords(p: { interval_unit: string; interval_count: number }): string {
  const u = p.interval_unit.toLowerCase();
  return p.interval_count === 1 ? `per ${u}` : `every ${p.interval_count} ${u}s`;
}
