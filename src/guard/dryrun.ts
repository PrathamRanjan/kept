/**
 * Dry-run money gate (roadmap B.6). Every move that touches PayPal or the subscriber's money passes through
 * `gate` before the executor is called. It checks, in order: kill switches, integer money, provenance of any
 * amount, the owner's rules and autonomy limits, the compliance scorecard for the offer step, and live PayPal
 * state. The decision is written to the trace before PayPal sees anything.
 *
 * One rule stands above every other: a cancel is never held or denied by the owner's rules, autonomy limits or
 * an agent kill switch. Cancelling is the subscriber's right (ROSCA; the state laws on the compliance page).
 * Only the global kill switch, which stops every PayPal write, can delay one, and then Kept retries it.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";
import { paypalFor } from "../paypal/index.js";
import { scoreCompliance, type Jurisdiction } from "../policy/compliance.js";
import type { Rules } from "../policy/rules.js";
import type { Run } from "../trace.js";
import { appendAudit } from "./audit.js";
import { isKilled } from "./kill.js";
import { moneyArgumentOk } from "./provenance.js";
import { notifyParty } from "../channels/index.js";

export type MoneyAction = "subscribe" | "skip" | "pause" | "resume" | "switch" | "cancel" | "offer" | "capture" | "invoice" | "refund";

export interface MoneyMove {
  action: MoneyAction;
  merchantId: string;
  /** Who is acting: "agent:<id>", "subscriber", "owner", "worker", "system". */
  agentScope: string;
  entity: "subscriber" | "offer" | "merchant";
  entityId: string;
  /** Amount in cents for capture, invoice, refund; the offer's per-cycle value for offers. */
  cents?: number;
  /** Amounts code or PayPal derived (outstanding balance, plan price); the only values an amount may equal. */
  trustedCents?: number[];
  /** PayPal subscription id to read live state from, when there is one, and whose credentials to read it with. */
  paypalSubscriptionId?: string | null;
  merchant?: { id: string; paypal_env: string; paypal_credentials: string | null } | null;
  rules?: Rules | null;
  jurisdiction?: Jurisdiction | null;
  /** For offers: the chosen offer's type and discount percent / pause cycles. */
  offer?: { type: string; percent?: number; cycles?: number } | null;
  /** A hand click by the owner or subscriber. Holds apply to agents and the worker, not to a person's own click. */
  customerInitiated?: boolean;
  note?: string;
}

export interface GuardSettings {
  auto_discount_max_pct: number;
  auto_pause_max_cycles: number;
  approve_capture_above_cents: number;
}
export const DEFAULT_GUARD: GuardSettings = { auto_discount_max_pct: 15, auto_pause_max_cycles: 2, approve_capture_above_cents: 5000 };

export async function guardSettings(merchantId: string, q?: Queryable): Promise<GuardSettings> {
  const db = q ?? (await getDb());
  const r = (await db.query<GuardSettings>("SELECT auto_discount_max_pct, auto_pause_max_cycles, approve_capture_above_cents FROM guard_settings WHERE merchant_id = $1", [merchantId])).rows[0];
  return r ? { auto_discount_max_pct: Number(r.auto_discount_max_pct), auto_pause_max_cycles: Number(r.auto_pause_max_cycles), approve_capture_above_cents: Number(r.approve_capture_above_cents) } : { ...DEFAULT_GUARD };
}

export async function saveGuardSettings(merchantId: string, s: Partial<GuardSettings>, by: string) {
  const db = await getDb();
  const cur = await guardSettings(merchantId, db);
  const next: GuardSettings = {
    auto_discount_max_pct: clamp(s.auto_discount_max_pct ?? cur.auto_discount_max_pct, 0, 50),
    auto_pause_max_cycles: clamp(s.auto_pause_max_cycles ?? cur.auto_pause_max_cycles, 0, 6),
    approve_capture_above_cents: clamp(s.approve_capture_above_cents ?? cur.approve_capture_above_cents, 0, 1_000_000),
  };
  await db.query(
    "INSERT INTO guard_settings (merchant_id, auto_discount_max_pct, auto_pause_max_cycles, approve_capture_above_cents, updated_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (merchant_id) DO UPDATE SET auto_discount_max_pct = EXCLUDED.auto_discount_max_pct, auto_pause_max_cycles = EXCLUDED.auto_pause_max_cycles, approve_capture_above_cents = EXCLUDED.approve_capture_above_cents, updated_at = now()",
    [merchantId, next.auto_discount_max_pct, next.auto_pause_max_cycles, next.approve_capture_above_cents],
  );
  await appendAudit("guard.settings", "merchant", merchantId, { ...next, by });
  return next;
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

export class GateDenied extends Error {
  constructor(message: string, readonly code: "denied" | "dry_run_refused") {
    super(message);
  }
}
export class HeldForApproval extends Error {
  constructor(message: string, readonly approvalId: string) {
    super(message);
  }
}

export interface GateDecision {
  decision: "allowed" | "dry_run_refused" | "held" | "denied";
  reason: string;
  policy: string | null;
  approvalId?: string;
  checks: { name: string; ok: boolean; note: string }[];
}

export function payloadHash(move: MoneyMove): string {
  const { action, merchantId, entity, entityId, cents } = move;
  return createHash("sha256").update(JSON.stringify({ action, merchantId, entity, entityId, cents: cents ?? null })).digest("hex");
}

/**
 * Decide without acting. Pure apart from reads: PayPal is only read (never written), approvals are only
 * created when the decision is "held".
 */
export async function dryRun(move: MoneyMove, opts: { createApproval?: boolean; q?: Queryable } = {}): Promise<GateDecision> {
  const db = opts.q ?? (await getDb());
  const checks: GateDecision["checks"] = [];
  const deny = (reason: string, policy: string | null = null, decision: GateDecision["decision"] = "denied"): GateDecision => ({ decision, reason, policy, checks });
  const isCancel = move.action === "cancel";

  // 1. Kill switches. Global stops every write; the others never stop a cancel.
  const global = await isKilled("global", db);
  if (global?.engaged && global.scope === "global") {
    checks.push({ name: "kill switch", ok: false, note: `global kill engaged: ${global.reason ?? "no reason given"}` });
    return deny(`Stopped by the global kill switch${global.reason ? ` (${global.reason})` : ""}.`, "kill:global");
  }
  for (const scope of [`merchant:${move.merchantId}`, move.agentScope, move.agentScope.startsWith("agent:") ? "agents" : null].filter(Boolean) as string[]) {
    const k = await isKilled(scope, db);
    if (k?.engaged) {
      if (isCancel) {
        checks.push({ name: "kill switch", ok: true, note: `${scope} is killed, but a cancel is never blocked by it` });
        continue;
      }
      checks.push({ name: "kill switch", ok: false, note: `${scope} engaged: ${k.reason ?? ""}` });
      return deny(`Stopped by the kill switch on ${scope}${k.reason ? ` (${k.reason})` : ""}.`, `kill:${scope}`);
    }
  }
  checks.push({ name: "kill switch", ok: true, note: "no kill switch engaged for this move" });

  // 2. Money is a positive whole number of cents, and comes from somewhere trusted.
  const moneyActions: MoneyAction[] = ["capture", "invoice", "refund"];
  if (moneyActions.includes(move.action)) {
    const c = move.cents;
    if (c === undefined || !Number.isInteger(c) || c <= 0) {
      checks.push({ name: "integer money", ok: false, note: `amount ${c} is not a positive whole number of cents` });
      return deny(`Refused before PayPal: amount ${c} is not a positive whole number of cents.`, "money:integer", "dry_run_refused");
    }
    checks.push({ name: "integer money", ok: true, note: `${c} cents` });
    const prov = await moneyArgumentOk(move.entity, move.entityId, c, move.trustedCents ?? [], db);
    checks.push({ name: "provenance", ok: prov.ok, note: prov.reason });
    if (!prov.ok) return deny(`Refused before PayPal: ${prov.reason}.`, "money:provenance");
  }

  // 3. The owner's rules and autonomy limits (never for a cancel).
  const rules = move.rules ?? null;
  const settings = await guardSettings(move.merchantId, db);
  if (!isCancel && rules) {
    if (move.action === "skip" && !rules.skip.enabled) return failRule("The shop's rules do not allow skips.", "rules.skip");
    if (move.action === "pause" && !rules.pause.enabled) return failRule("The shop's rules do not allow pauses.", "rules.pause");
    if (move.action === "pause" && move.offer?.cycles && move.offer.cycles > rules.pause.maxCycles) return failRule(`Pauses are limited to ${rules.pause.maxCycles} cycles.`, "rules.pause.maxCycles");
    if (move.action === "offer" && move.offer) {
      if (move.offer.type === "discount" && (move.offer.percent ?? 0) > rules.maxDiscountPercent) return failRule(`A ${move.offer.percent}% discount is above the ${rules.maxDiscountPercent}% maximum in the rules.`, "rules.maxDiscountPercent");
      if (move.offer.type === "discount" && (move.offer.percent ?? 0) > settings.auto_discount_max_pct && !move.customerInitiated) {
        checks.push({ name: "autonomy", ok: false, note: `${move.offer.percent}% is above the ${settings.auto_discount_max_pct}% the owner lets the offer step give on its own` });
        return await hold(`A ${move.offer.percent}% discount needs the owner: autonomy is ${settings.auto_discount_max_pct}%.`, "autonomy.discount");
      }
      if (move.offer.type === "pause" && (move.offer.cycles ?? 0) > settings.auto_pause_max_cycles && !move.customerInitiated) {
        checks.push({ name: "autonomy", ok: false, note: `${move.offer.cycles} cycles is above the ${settings.auto_pause_max_cycles} the owner lets the offer step give on its own` });
        return await hold(`A ${move.offer.cycles}-cycle pause needs the owner: autonomy is ${settings.auto_pause_max_cycles} cycles.`, "autonomy.pause");
      }
    }
    checks.push({ name: "rules", ok: true, note: "within the shop's rules" });
  }
  if (!isCancel && moneyActions.includes(move.action) && (move.cents ?? 0) > settings.approve_capture_above_cents && !move.customerInitiated) {
    checks.push({ name: "autonomy", ok: false, note: `${move.cents} cents is above the owner's ${settings.approve_capture_above_cents}-cent approval threshold` });
    return await hold(`${(move.cents! / 100).toFixed(2)} needs the owner's approval (threshold ${(settings.approve_capture_above_cents / 100).toFixed(2)}).`, "autonomy.capture");
  }

  // 4. Compliance scorecard: a failing rule for the buyer's jurisdiction blocks the offer step in code.
  if (move.action === "offer" && rules) {
    const score = scoreCompliance(rules, move.jurisdiction ?? rules.jurisdiction ?? "US_FEDERAL");
    const failing = score.rules.filter((r) => r.status === "fail");
    if (failing.length) {
      checks.push({ name: "compliance", ok: false, note: failing.map((f) => `${f.id}: ${f.title}`).join("; ") });
      return deny(`No offer: the policy fails ${failing[0].jurisdiction} rule ${failing[0].id} (${failing[0].title}). The cancel goes through.`, `compliance:${failing[0].id}`);
    }
    checks.push({ name: "compliance", ok: true, note: `${score.passed}/${score.total} rules pass for ${score.jurisdiction}` });
  }

  // 5. Live PayPal state: refuse moves the subscription's real status cannot take.
  if (move.paypalSubscriptionId && move.action !== "subscribe" && move.action !== "offer") {
    try {
      const pp = await paypalFor(move.merchant ?? null).getSubscription(move.paypalSubscriptionId);
      const st = pp.status;
      const outstanding = Math.round(Number(pp.billing_info?.outstanding_balance?.value ?? 0) * 100);
      const want: Partial<Record<MoneyAction, string[]>> = { skip: ["ACTIVE"], pause: ["ACTIVE"], resume: ["SUSPENDED"], switch: ["ACTIVE", "SUSPENDED"], cancel: ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED"], capture: ["ACTIVE", "SUSPENDED"], invoice: ["ACTIVE", "SUSPENDED"], refund: ["ACTIVE", "SUSPENDED", "CANCELLED"] };
      const allowed = want[move.action];
      if (allowed && !allowed.includes(st)) {
        checks.push({ name: "live PayPal state", ok: false, note: `PayPal shows ${st}; ${move.action} needs ${allowed.join(" or ")}` });
        return deny(`Refused before PayPal: the subscription is ${st} at PayPal, so it cannot ${move.action}.`, "paypal:status", "dry_run_refused");
      }
      if (move.action === "capture" || move.action === "invoice") {
        if (outstanding <= 0) {
          checks.push({ name: "live PayPal state", ok: false, note: "PayPal shows no outstanding balance" });
          return deny("Refused before PayPal: PayPal shows nothing outstanding on this subscription.", "paypal:outstanding", "dry_run_refused");
        }
        if ((move.cents ?? 0) > outstanding) {
          checks.push({ name: "live PayPal state", ok: false, note: `amount ${move.cents} is above the ${outstanding} outstanding at PayPal` });
          return deny(`Refused before PayPal: ${(move.cents! / 100).toFixed(2)} is more than the ${(outstanding / 100).toFixed(2)} PayPal says is outstanding.`, "paypal:outstanding", "dry_run_refused");
        }
      }
      checks.push({ name: "live PayPal state", ok: true, note: `PayPal shows ${st}${outstanding ? `, outstanding ${(outstanding / 100).toFixed(2)}` : ""}` });
    } catch (e) {
      // Could not read PayPal: a cancel still goes ahead (the executor retries until PayPal confirms); anything else waits.
      checks.push({ name: "live PayPal state", ok: isCancel, note: `could not read PayPal: ${(e as Error).message.slice(0, 120)}` });
      if (!isCancel) return deny("Refused before PayPal: the subscription could not be read back, so the move is not attempted.", "paypal:unreadable", "dry_run_refused");
    }
  }

  return { decision: "allowed", reason: isCancel ? "cancel: always honoured" : "within rules, autonomy and live PayPal state", policy: null, checks };

  function failRule(reason: string, policy: string): GateDecision {
    checks.push({ name: "rules", ok: false, note: reason });
    return deny(reason, policy);
  }
  async function hold(reason: string, policy: string): Promise<GateDecision> {
    if (!opts.createApproval) return { decision: "held", reason, policy, checks };
    const id = newId("apr");
    const hash = payloadHash(move);
    await db.query("INSERT INTO approvals (id, merchant_id, action, payload_hash, payload, status) VALUES ($1,$2,$3,$4,$5,'pending')", [id, move.merchantId, move.action, hash, JSON.stringify({ ...move, reason })]);
    await appendAudit("approval.requested", "approval", id, { merchantId: move.merchantId, action: move.action, cents: move.cents ?? null, offer: move.offer ?? null, hash });
    const label = move.action === "offer" ? `${move.offer?.type} ${move.offer?.percent ? `${move.offer.percent}%` : move.offer?.cycles ? `${move.offer.cycles} cycles` : ""}`.trim() : `${move.action} ${((move.cents ?? 0) / 100).toFixed(2)}`;
    await notifyParty("owner", move.merchantId, `Kept held a ${label} (${reason}). Approve or decline.`, [{ id: `approve:${id}`, label: "Approve" }, { id: `decline:${id}`, label: "Decline" }], "approval", id, db);
    return { decision: "held", reason, policy, approvalId: id, checks };
  }
}

/** The gate: a dry run whose decision is recorded as a trace step; anything but "allowed" throws. */
export async function gate(move: MoneyMove, run: Run | null, q?: Queryable): Promise<GateDecision> {
  const t0 = Date.now();
  const d = await dryRun(move, { createApproval: true, q });
  if (run) await run.step({ actor: "guard", tool: `gate.${move.action}`, args: { entity: move.entity, entityId: move.entityId, cents: move.cents ?? null, offer: move.offer ?? null, agentScope: move.agentScope }, policy: d.policy, gate: d.decision, result: { reason: d.reason, checks: d.checks, approvalId: d.approvalId ?? null }, duration_ms: Date.now() - t0 });
  if (d.decision === "held") throw new HeldForApproval(d.reason, d.approvalId ?? "");
  if (d.decision !== "allowed") throw new GateDenied(d.reason, d.decision);
  return d;
}

/** Owner decides a held move; above the countersign threshold the decision must carry a passkey. */
export async function decideApproval(id: string, merchantId: string, approve: boolean, method: "click" | "passkey" | "channel", by: string) {
  const db = await getDb();
  const a = (await db.query<any>("SELECT * FROM approvals WHERE id = $1 AND merchant_id = $2", [id, merchantId])).rows[0];
  if (!a) throw new Error("No such approval");
  if (a.status !== "pending") return { status: a.status as string, replayed: true };
  const payload = typeof a.payload === "string" ? JSON.parse(a.payload) : a.payload;
  const cents = Number(payload.cents ?? 0);
  if (approve && cents >= config.guard.countersignAboveCents && method !== "passkey") {
    const { hasPasskey } = await import("./passkey.js");
    if (await hasPasskey(merchantId, db)) throw new Error(`Approvals of ${(cents / 100).toFixed(2)} and above need your passkey.`);
  }
  await db.query("UPDATE approvals SET status = $2, method = $3, decided_at = now() WHERE id = $1", [id, approve ? "approved" : "declined", method]);
  await appendAudit(approve ? "approval.approved" : "approval.declined", "approval", id, { by, method, hash: a.payload_hash, action: a.action });
  return { status: approve ? "approved" : "declined", payload, replayed: false };
}

export async function pendingApprovals(merchantId: string) {
  const db = await getDb();
  return (await db.query<any>("SELECT * FROM approvals WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 100", [merchantId])).rows.map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
}

/** Has the owner approved this exact move? Used so a held offer the owner approves can be made next time. */
export async function approvedFor(move: MoneyMove, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  const hash = payloadHash(move);
  return (await db.query("SELECT 1 FROM approvals WHERE merchant_id = $1 AND payload_hash = $2 AND status = 'approved' AND decided_at > now() - interval '1 day' LIMIT 1", [move.merchantId, hash])).rows.length > 0;
}
