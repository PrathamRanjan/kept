import type { Queryable } from "./db.js";
import { normLang, PAYPAL_LOCALE } from "./i18n.js";
import { config } from "./config.js";
import { requestKey } from "./lib/ids.js";
import { paypalFor, PayPalError, PayPalSubscription } from "./paypal/index.js";
import { KeptError, logEvent, Merchant, Plan, planByPayPalId, Subscriber, subscriberById, updateSubscriber } from "./store.js";

/**
 * The executor is the only code path that writes to PayPal. Every write:
 *  1. is logged before it is sent,
 *  2. carries a deterministic PayPal-Request-Id (retries never repeat at PayPal),
 *  3. is followed by a read-back of the subscription, and only the read-back updates Kept's state.
 */

function wrap(e: unknown, action: string): never {
  if (e instanceof KeptError) throw e;
  if (e instanceof PayPalError) {
    throw new KeptError(`PayPal refused ${action}: ${e.message}`, "paypal_error", e.status >= 500 ? 502 : 422, { debugId: e.debugId, paypalName: e.name_ });
  }
  throw new KeptError(`Could not reach PayPal for ${action}: ${(e as Error).message}`, "paypal_unreachable", 502);
}

async function record(q: Queryable, m: Merchant, s: Subscriber | null, type: string, summary: string, payload?: unknown, paypal?: unknown) {
  await logEvent(q, { merchantId: m.id, subscriberId: s?.id ?? null, source: "executor", type, summary, payload, paypal, sample: s?.is_sample ?? false });
}

/** Copy PayPal's view of a subscription into Kept. Returns the updated subscriber and the raw PayPal object. */
export async function readBack(q: Queryable, m: Merchant, s: Subscriber): Promise<{ sub: Subscriber; pp: PayPalSubscription | null }> {
  if (!s.paypal_subscription_id) return { sub: s, pp: null };
  let pp: PayPalSubscription;
  try {
    pp = await paypalFor(m).getSubscription(s.paypal_subscription_id);
  } catch (e) {
    // A pending cancellation is an intent, not a reading: a failed read never replaces it.
    if (s.kept_state === "cancel_pending") {
      await record(q, m, s, "paypal.read_failed", "Could not read the subscription back from PayPal; the pending cancellation stands and will be retried", undefined, { message: (e as Error).message });
      return { sub: s, pp: null };
    }
    await record(q, m, s, "paypal.read_failed", "Could not read the subscription back from PayPal; state marked unconfirmed", undefined, { message: (e as Error).message });
    await updateSubscriber(q, s.id, { kept_state: "unconfirmed" });
    return { sub: { ...s, kept_state: "unconfirmed" }, pp: null };
  }
  const plan = await planByPayPalId(q, m.id, pp.plan_id);
  const bi = pp.billing_info ?? {};
  const fields: Record<string, unknown> = {
    status: pp.status,
    next_billing_time: bi.next_billing_time ? new Date(bi.next_billing_time) : null,
    outstanding: Number(bi.outstanding_balance?.value ?? 0),
    failed_payments: bi.failed_payments_count ?? 0,
  };
  if (plan && plan.merchant_id === m.id) fields.plan_id = plan.id;
  if (bi.last_payment) {
    fields.last_payment_amount = Number(bi.last_payment.amount.value);
    fields.last_payment_time = new Date(bi.last_payment.time);
  }
  if (pp.subscriber?.email_address && !s.subscriber_email) fields.subscriber_email = pp.subscriber.email_address;
  if (pp.subscriber?.name?.given_name && !s.subscriber_name) fields.subscriber_name = [pp.subscriber.name.given_name, pp.subscriber.name.surname].filter(Boolean).join(" ");
  if (["ACTIVE", "SUSPENDED"].includes(pp.status) && !s.started_at) fields.started_at = pp.start_time ? new Date(pp.start_time) : new Date();
  if (pp.status === "CANCELLED" && !s.cancelled_at) fields.cancelled_at = new Date();
  if (s.kept_state === "unconfirmed") fields.kept_state = null;
  if (s.status !== pp.status) {
    await record(q, m, s, "status.changed", `Status ${s.status} → ${pp.status} (read from PayPal)`, { from: s.status, to: pp.status });
  }
  await updateSubscriber(q, s.id, fields as any);
  const sub = (await subscriberById(q, s.id))!;
  return { sub, pp };
}

export async function createSubscription(
  q: Queryable,
  m: Merchant,
  s: Subscriber,
  plan: Plan,
  key: string,
): Promise<{ paypalId: string; approveUrl: string | null }> {
  if (!plan.paypal_plan_id) throw new KeptError("This plan is not linked to PayPal yet.", "plan_not_ready", 409);
  await record(q, m, s, "paypal.subscription.create.requested", `Create PayPal subscription on ${plan.name}`, { planId: plan.id });
  try {
    const out = await paypalFor(m).createSubscription(
      {
        planId: plan.paypal_plan_id,
        // "<shop>:<member>": a webhook that reaches Kept before the row is linked can still find its shop.
        customId: `${m.id}:${s.id}`,
        brandName: m.name,
        returnUrl: `${config.appUrl}/r/${s.ref}`,
        cancelUrl: `${config.appUrl}/r/${s.ref}?cancelled=1`,
        subscriberEmail: s.subscriber_email ?? undefined,
        subscriberName: s.subscriber_name ?? undefined,
        locale: PAYPAL_LOCALE[normLang(s.lang)] ?? undefined,
      },
      requestKey("create-sub", s.id, key),
    );
    await updateSubscriber(q, s.id, { paypal_subscription_id: out.id, approval_url: out.approveUrl, status: out.status });
    await q.query("INSERT INTO paypal_refs (resource_id, ws_id, merchant_id, kind) VALUES ($1, (SELECT id FROM workspaces WHERE tenant_id = $2), $2, 'subscription') ON CONFLICT (resource_id) DO NOTHING", [out.id, m.id]);
    await record(q, m, s, "paypal.subscription.created", `PayPal subscription ${out.id} created; waiting for the subscriber to approve on PayPal`, undefined, out);
    return { paypalId: out.id, approveUrl: out.approveUrl };
  } catch (e) {
    await record(q, m, s, "paypal.subscription.create.failed", "PayPal refused to create the subscription", undefined, { message: (e as Error).message });
    wrap(e, "creating the subscription");
  }
}

async function simpleWrite(
  q: Queryable,
  m: Merchant,
  s: Subscriber,
  action: "suspend" | "activate" | "cancel",
  reason: string,
  key: string,
  expect: string[],
): Promise<Subscriber> {
  if (!s.paypal_subscription_id) throw new KeptError("This subscription has not been approved on PayPal yet.", "not_approved", 409);
  const pp = paypalFor(m);
  await record(q, m, s, `paypal.subscription.${action}.requested`, `${action} requested: ${reason}`);
  try {
    const rid = requestKey(action, s.id, key);
    if (action === "suspend") await pp.suspendSubscription(s.paypal_subscription_id, reason, rid);
    else if (action === "activate") await pp.activateSubscription(s.paypal_subscription_id, reason, rid);
    else await pp.cancelSubscription(s.paypal_subscription_id, reason, rid);
  } catch (e) {
    // A repeat of an already-applied change comes back as "status invalid": read back before treating it as a failure.
    const { sub } = await readBack(q, m, s);
    if (expect.includes(sub.status)) {
      await record(q, m, sub, `paypal.subscription.${action}.confirmed`, `Already ${sub.status} at PayPal (read back)`);
      return sub;
    }
    await record(q, m, s, `paypal.subscription.${action}.failed`, `PayPal refused ${action}`, undefined, { message: (e as Error).message });
    wrap(e, action);
  }
  const { sub } = await readBack(q, m, s);
  if (!expect.includes(sub.status)) {
    await record(q, m, sub, `paypal.subscription.${action}.unconfirmed`, `PayPal accepted ${action} but read-back shows ${sub.status}`);
    await updateSubscriber(q, s.id, { kept_state: "unconfirmed" });
    throw new KeptError(`PayPal accepted the ${action} but still shows the subscription as ${sub.status}. Kept will re-check shortly.`, "unconfirmed", 409);
  }
  await record(q, m, sub, `paypal.subscription.${action}.confirmed`, `${action} confirmed; PayPal shows ${sub.status}`);
  return sub;
}

export const suspend = (q: Queryable, m: Merchant, s: Subscriber, reason: string, key: string) => simpleWrite(q, m, s, "suspend", reason, key, ["SUSPENDED"]);
export const activate = (q: Queryable, m: Merchant, s: Subscriber, reason: string, key: string) => simpleWrite(q, m, s, "activate", reason, key, ["ACTIVE"]);
export const cancel = (q: Queryable, m: Merchant, s: Subscriber, reason: string, key: string) => simpleWrite(q, m, s, "cancel", reason, key, ["CANCELLED"]);

export async function revise(q: Queryable, m: Merchant, s: Subscriber, target: Plan, key: string): Promise<{ sub: Subscriber; approveUrl: string | null; confirmed: boolean }> {
  if (!s.paypal_subscription_id) throw new KeptError("This subscription has not been approved on PayPal yet.", "not_approved", 409);
  if (!target.paypal_plan_id) throw new KeptError("That plan is not linked to PayPal yet.", "plan_not_ready", 409);
  await record(q, m, s, "paypal.subscription.revise.requested", `Change plan to ${target.name}`, { toPlanId: target.id });
  let out: { approveUrl: string | null; planId: string };
  try {
    out = await paypalFor(m).reviseSubscription(s.paypal_subscription_id, target.paypal_plan_id, requestKey("revise", s.id, target.id, key), {
      returnUrl: `${config.appUrl}/r/${s.ref}?revised=1`,
      cancelUrl: `${config.appUrl}/r/${s.ref}`,
    });
  } catch (e) {
    await record(q, m, s, "paypal.subscription.revise.failed", "PayPal refused the plan change", undefined, { message: (e as Error).message });
    wrap(e, "the plan change");
  }
  if (out.approveUrl) {
    await updateSubscriber(q, s.id, { kept_state: `switch_pending:${target.id}`, approval_url: out.approveUrl });
    await record(q, m, s, "paypal.subscription.revise.consent_needed", `PayPal needs the subscriber to approve the change to ${target.name}`, undefined, out);
    return { sub: (await subscriberById(q, s.id))!, approveUrl: out.approveUrl, confirmed: false };
  }
  const { sub } = await readBack(q, m, s);
  const confirmed = sub.plan_id === target.id;
  await record(q, m, sub, confirmed ? "paypal.subscription.revise.confirmed" : "paypal.subscription.revise.scheduled", confirmed ? `Plan is now ${target.name} at PayPal` : `PayPal accepted the change to ${target.name}; it applies from the next billing cycle`);
  if (!confirmed) await updateSubscriber(q, s.id, { kept_state: `switch_scheduled:${target.id}` });
  return { sub: (await subscriberById(q, s.id))!, approveUrl: null, confirmed };
}

/** Spec B5 (7): refund part of a completed sale. Reads the refund back from PayPal before reporting it done. */
export async function refundSale(q: Queryable, m: Merchant, s: Subscriber, saleId: string, amount: string, key: string): Promise<{ refundId: string; state: string; readBack: string }> {
  await record(q, m, s, "paypal.refund.requested", `Refund ${amount} ${m.currency} of sale ${saleId} (the unused part of the cycle)`);
  try {
    const pp = paypalFor(m);
    const out = await pp.refundSale(saleId, amount, m.currency, requestKey("refund", s.id, saleId, key));
    const back = await pp.getRefund(out.id);
    await record(q, m, s, "paypal.refund.confirmed", `PayPal shows refund ${back.id} ${back.state} for ${back.amount ?? amount} ${m.currency}`, { refundId: back.id, saleId }, back);
    return { refundId: back.id, state: back.state, readBack: `refund ${back.id} ${back.state}${back.amount ? ` for ${back.amount}` : ""}` };
  } catch (e) {
    await record(q, m, s, "paypal.refund.failed", "PayPal did not complete the refund", undefined, { message: (e as Error).message });
    wrap(e, "refunding the unused part of the cycle");
  }
}

export async function captureOutstanding(q: Queryable, m: Merchant, s: Subscriber, key: string): Promise<{ sub: Subscriber; captured: string | null; note: string }> {
  if (!s.paypal_subscription_id) throw new KeptError("This subscription has not been approved on PayPal yet.", "not_approved", 409);
  const { sub: fresh } = await readBack(q, m, s);
  const owed = fresh.outstanding;
  if (!(owed > 0)) {
    await record(q, m, fresh, "paypal.subscription.capture.skipped", "PayPal shows no outstanding balance, so nothing was captured");
    return { sub: fresh, captured: null, note: "PayPal shows nothing outstanding on this subscription." };
  }
  await record(q, m, fresh, "paypal.subscription.capture.requested", `Capture outstanding balance ${owed.toFixed(2)} ${m.currency}`);
  try {
    const out = await paypalFor(m).captureOutstanding(s.paypal_subscription_id, owed.toFixed(2), m.currency, "Outstanding renewal after payment method update", requestKey("capture", s.id, owed.toFixed(2), key));
    const { sub } = await readBack(q, m, fresh);
    await record(q, m, sub, "paypal.subscription.capture.confirmed", `Captured ${owed.toFixed(2)} ${m.currency}; outstanding now ${sub.outstanding.toFixed(2)}`, undefined, out);
    return { sub, captured: owed.toFixed(2), note: "Outstanding balance collected." };
  } catch (e) {
    await record(q, m, fresh, "paypal.subscription.capture.failed", "PayPal could not collect the outstanding balance", undefined, { message: (e as Error).message });
    wrap(e, "collecting the outstanding balance");
  }
}
