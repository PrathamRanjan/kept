/**
 * Spec B5 differentiator 10: a signed record of what the member's assistant was allowed to do, in the spirit of
 * AP2 mandates (scope, limits, expiry, signature), not an implementation of that protocol. Code issues it before the
 * assistant starts, from the member's own words: the cancel tools are in scope only if the member said cancel,
 * stop or end. Code checks it before every change; the model cannot widen it. Signed with HMAC-SHA256 under the
 * server's secret, so anyone can ask Kept whether a mandate is genuine (GET /api/public/mandate/:id).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";

export interface Mandate {
  id: string;
  issuer: string;
  agent: string;
  shop: string;
  member: string;
  scope: string[];
  limits: { pause_max_cycles: number; may_cancel: boolean; may_accept_offer: boolean; moves_money: false };
  because: string;
  issued_at: string;
  expires_at: string;
}

const CANCEL_WORDS = /\b(cancel|cancell?ing|stop|end|quit|unsubscribe|close (it|my)|leave)\b/i;
const READS = ["get_subscription", "list_plans"];
const CHANGES = ["skip_next", "pause", "resume", "switch_plan"];
const ENDS = ["cancel_subscription", "respond_to_offer"];

const canonical = (m: Mandate) => JSON.stringify(m, Object.keys(m).sort());
const mac = (m: Mandate) => createHmac("sha256", "kept-mandate:" + config.sessionSecret).update(canonical(m)).digest("base64url");

export async function issueMandate(o: { merchantId: string; shopName: string; subscriberId: string; memberName: string; agent: string; message: string; pauseMaxCycles: number; minutes?: number }) {
  const mayCancel = CANCEL_WORDS.test(o.message);
  const now = new Date();
  const m: Mandate = {
    id: newId("mdt"),
    issuer: "Kept",
    agent: o.agent,
    shop: o.shopName,
    member: o.memberName,
    scope: [...READS, ...CHANGES, ...(mayCancel ? ENDS : [])],
    limits: { pause_max_cycles: o.pauseMaxCycles, may_cancel: mayCancel, may_accept_offer: mayCancel, moves_money: false },
    because: mayCancel ? "The member's message asks to cancel, so cancelling is in scope." : "The member's message does not ask to cancel, so cancelling is out of scope for this request.",
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (o.minutes ?? 15) * 60_000).toISOString(),
  };
  const signature = mac(m);
  await (await getDb()).query("INSERT INTO mandates (id, merchant_id, subscriber_id, record, signature) VALUES ($1,$2,$3,$4,$5)", [m.id, o.merchantId, o.subscriberId, JSON.stringify(m), signature]);
  return { mandate: m, signature };
}

export function verify(m: Mandate, signature: string): boolean {
  const a = Buffer.from(mac(m));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Code's check before every change. Returns the reason it is refused, or null when allowed. */
export function refuses(m: Mandate, signature: string, tool: string, args: Record<string, unknown> = {}, now = new Date()): string | null {
  if (!verify(m, signature)) return "the mandate's signature does not match";
  if (now.getTime() > new Date(m.expires_at).getTime()) return "the mandate has expired";
  if (!m.scope.includes(tool)) return `${tool.replace(/_/g, " ")} is outside this mandate (${m.because.toLowerCase()})`;
  if (tool === "pause" && Number(args.cycles ?? 1) > m.limits.pause_max_cycles) return `a pause of ${args.cycles} cycles is over the mandate's limit of ${m.limits.pause_max_cycles}`;
  return null;
}

export async function mandateById(id: string) {
  const r = (await (await getDb()).query<{ record: any; signature: string; created_at: Date }>("SELECT record, signature, created_at FROM mandates WHERE id = $1", [id])).rows[0];
  if (!r) return null;
  const m = (typeof r.record === "string" ? JSON.parse(r.record) : r.record) as Mandate;
  return { mandate: m, signature: r.signature, valid: verify(m, r.signature), expired: Date.now() > new Date(m.expires_at).getTime() };
}
