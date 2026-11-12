/**
 * What Kept does with an inbound channel message (Telegram, WhatsApp or SMS).
 *  - "link subscriber:<ref>" / "link owner:<owner key>" ties the chat to a party.
 *  - Buttons: approve:/decline:<approval id> (owner), skip:/keep:/cancel:/fixed:<ref> (subscriber).
 *  - Words: "status", "pending", "help".
 * Every money move goes through the same service functions, so the gate and the trace apply.
 */
import { getDb } from "../db.js";
import { decideApproval, pendingApprovals } from "../guard/dryrun.js";
import * as svc from "../service.js";
import { KeptError, merchantByToken, subscriberByRef, subscriberById } from "../store.js";
import { link, onInbound, send, type Channel } from "./index.js";

const describeApproval = (a: any) => (a.payload?.offer ? `${a.payload.offer.type} ${a.payload.offer.percent ? `${a.payload.offer.percent}% off` : a.payload.offer.cycles ? `${a.payload.offer.cycles} cycles` : ""}`.trim() : `${a.action} ${((a.payload?.cents ?? 0) / 100).toFixed(2)}`);

/** A renewal reminder with Skip and Keep buttons, sent right after a member connects a chat. */
async function firstReminder(channel: Channel, address: string, ref: string) {
  const v = await svc.subscriptionView(ref);
  const when = v.next_billing_time ? new Date(v.next_billing_time).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const what = v.plan ? `${v.plan.name} (${v.plan.price} ${v.plan.currency})` : "subscription";
  const body = `${v.shop}: your ${what} ${when ? `renews on ${when}` : "is active"}. Skip the next payment, or keep it? Tapping Skip changes it in PayPal.`;
  await send({ channel, address, body, buttons: [{ id: `skip:${ref}`, label: "Skip next payment" }, { id: `keep:${ref}`, label: "Keep it" }], entity: "subscriber", entityId: ref });
}

let installed = false;
export function installChannelHandlers() {
  if (installed) return;
  installed = true;
  onInbound(async (msg) => {
    // Telegram's command menu sends "/pending" or "/help@kept_paypal_demo_bot": read those as the bare word ("/start" stays as is).
    const text = (msg.text ?? "").trim().replace(/^\/(?!start\b)([a-z]+)(?:@\S+)?/i, "$1");
    const db = await getDb();
    // One tap from the app: "/start <one-time code>" (the shared bot strips its "kept-" prefix). Codes last 15 minutes and work once.
    const st = text.match(/^\/start(?:\s+(\S+))?$/i);
    if (st) {
      // Kept's own bot gets "kept-<code>" (the prefix the shared bot used to route by); both forms work.
      const code = (st[1] ?? "").replace(/^kept-/, "");
      const row = code ? (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [`tglink:${code}`])).rows[0] : undefined;
      if (code) await db.query("DELETE FROM settings WHERE key = $1", [`tglink:${code}`]);
      const v = row ? (JSON.parse(row.value) as { party: "owner" | "subscriber"; party_id: string; exp: number }) : null;
      if (!v || v.exp < Date.now()) return code ? "That connect link has expired. Open Kept and tap “Connect Telegram” again." : "Hi, this is Kept. Open your member page (or your shop's Messages page) and tap the Telegram button to connect this chat.";
      await link(msg.channel, msg.address, v.party, v.party_id);
      if (v.party === "subscriber") {
        const s = await subscriberById(db, v.party_id);
        // The first reminder comes straight away, so the buttons can be tried now rather than days before a renewal.
        if (s) await firstReminder(msg.channel, msg.address, s.ref).catch(() => undefined);
        return `Connected. You'll get renewal reminders, with Skip and Keep buttons, for ${s?.subscriber_name ? `${s.subscriber_name}'s subscription` : "your subscription"} here. A payment problem is only ever shown on your member page, never as a link in this chat.`;
      }
      const waiting = (await pendingApprovals(v.party_id)).filter((a) => a.status === "pending").slice(0, 3);
      for (const a of waiting) {
        await send({ channel: msg.channel, address: msg.address, body: `Waiting for you: ${describeApproval(a)}`, buttons: [{ id: `approve:${a.id}`, label: "Approve" }, { id: `decline:${a.id}`, label: "Decline" }] });
      }
      return `Connected as the shop owner. Held offers and large collections will ask you here with Approve and Decline buttons.${waiting.length ? ` ${waiting.length} ${waiting.length === 1 ? "is" : "are"} waiting now.` : ""} Send “pending” any time.`;
    }
    const m = text.match(/^link\s+(subscriber|owner):(\S+)$/i);
    // A phone number is linked only through the code Kept texts it, never by a typed reference.
    if (m && msg.channel === "sms") return "To get texts from Kept, turn them on from your member page.";
    if (m) {
      if (m[1].toLowerCase() === "subscriber") {
        const s = await subscriberByRef(db, m[2]);
        if (!s) return "No subscription with that reference.";
        await link(msg.channel, msg.address, "subscriber", s.id);
        return `Linked. You'll get renewal reminders and payment notices for ${s.subscriber_name ?? "your subscription"} here.`;
      }
      const o = await merchantByToken(db, m[2]);
      if (!o) return "That owner key is not recognised.";
      await link(msg.channel, msg.address, "owner", o.id);
      return `Linked as the owner of ${o.name}. Held offers and collections above your threshold will ask you here.`;
    }
    if (!msg.party) return msg.channel === "sms" ? "Kept: this number isn't connected. Turn on texts from your member page." : "Hi, this is Kept. This chat isn't connected yet: open your member page (or your shop's Messages page) and tap the Telegram button.";
    // A button id ("skip:<ref>"), the same typed out, or a bare word ("skip", "cancel", "fixed") for the linked subscription.
    const button = msg.buttonId ?? (text.match(/^(approve|decline|skip|keep|cancel|fixed)(?::(\S+))?$/i)?.[0] ?? null);
    const [verbRaw, id] = (button ?? "").split(":");
    const verb = verbRaw.toLowerCase();
    try {
      if (msg.party.party === "owner") {
        if ((verb === "approve" || verb === "decline") && id) {
          const r = await decideApproval(id, msg.party.party_id, verb === "approve", "channel", `${msg.channel}:${msg.address}`);
          return r.replayed ? `Already ${r.status}.` : verb === "approve" ? "Approved. Kept will act on it, and the autonomy page will suggest raising your limit if this keeps happening." : "Declined. Nothing moves.";
        }
        if (/^pending/i.test(text)) {
          const p = (await pendingApprovals(msg.party.party_id)).filter((a) => a.status === "pending");
          return p.length ? p.map((a) => `${a.id}: ${a.action} ${a.payload.offer ? `${a.payload.offer.type} ${a.payload.offer.percent ?? a.payload.offer.cycles ?? ""}` : ((a.payload.cents ?? 0) / 100).toFixed(2)} → approve:${a.id} or decline:${a.id}`).join("\n") : "Nothing is waiting for you.";
        }
        return "Owner commands: pending, approve:<id>, decline:<id>.";
      }
      // Subscriber
      const s = await subscriberById(db, msg.party.party_id);
      if (!s) return "Your subscription could not be found.";
      if (id && id !== s.ref) return "That button belongs to a different subscription.";
      const actor = { kind: "web" as const };
      if (verb === "skip") {
        const out = await svc.skipNext(s.ref, actor, `chan-skip-${s.id}-${new Date().toISOString().slice(0, 10)}`);
        return `Skipped. Nothing is charged this time; it resumes ${out.resumeAt.toISOString().slice(0, 10)}.`;
      }
      if (verb === "keep") return "Kept as it is. Nothing to do.";
      if (verb === "cancel") {
        const out = await svc.requestCancel(s.ref, { hearOffer: false }, actor, `chan-cancel-${s.id}`);
        return out.status === "cancelled" ? "Cancelled. No further charges." : out.note;
      }
      if (verb === "fixed") {
        const out = await svc.paymentFixed(s.ref, actor, `chan-fixed-${s.id}-${new Date().toISOString().slice(0, 10)}`);
        return out.captured ? `Thanks. ${out.captured} collected; the subscription continues.` : out.note;
      }
      if (/^status/i.test(text)) {
        const v = await svc.subscriptionView(s.ref);
        return `${v.shop}: ${v.status}${v.plan ? `, ${v.plan.name} ${v.plan.price} ${v.plan.currency} ${v.plan.billing}` : ""}${v.next_billing_time ? `, next charge ${v.next_billing_time.slice(0, 10)}` : ""}. Manage: ${v.manage_url}`;
      }
      return "Commands: status, skip, cancel, or tap a button on a reminder.";
    } catch (e) {
      return e instanceof KeptError ? e.message : "Something went wrong; try the manage page.";
    }
  });
}
