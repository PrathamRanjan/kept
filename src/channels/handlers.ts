/**
 * What Kept does with an inbound channel message (Telegram or WhatsApp).
 *  - "link subscriber:<ref>" / "link owner:<owner key>" ties the chat to a party.
 *  - Buttons: approve:/decline:<approval id> (owner), skip:/keep:/cancel:/fixed:<ref> (subscriber).
 *  - Words: "status", "pending", "help".
 * Every money move goes through the same service functions, so the gate and the trace apply.
 */
import { getDb } from "../db.js";
import { decideApproval, pendingApprovals } from "../guard/dryrun.js";
import * as svc from "../service.js";
import { KeptError, merchantByToken, subscriberByRef, subscriberById } from "../store.js";
import { link, onInbound } from "./index.js";

let installed = false;
export function installChannelHandlers() {
  if (installed) return;
  installed = true;
  onInbound(async (msg) => {
    const text = (msg.text ?? "").trim();
    const db = await getDb();
    // One tap from the app: "/start <one-time code>" (the shared bot strips its "kept-" prefix). Codes last 15 minutes and work once.
    const st = text.match(/^\/start(?:\s+(\S+))?$/i);
    if (st) {
      const code = st[1] ?? "";
      const row = code ? (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [`tglink:${code}`])).rows[0] : undefined;
      if (code) await db.query("DELETE FROM settings WHERE key = $1", [`tglink:${code}`]);
      const v = row ? (JSON.parse(row.value) as { party: "owner" | "subscriber"; party_id: string; exp: number }) : null;
      if (!v || v.exp < Date.now()) return code ? "That connect link has expired. Open Kept and tap “Connect Telegram” again." : "Hi, this is Kept. Open your member page (or your shop's Messages page) and tap the Telegram button to connect this chat.";
      await link(msg.channel, msg.address, v.party, v.party_id);
      if (v.party === "subscriber") {
        const s = await subscriberById(db, v.party_id);
        return `Connected. You'll get renewal reminders, with Skip and Keep buttons, for ${s?.subscriber_name ? `${s.subscriber_name}'s subscription` : "your subscription"} here. A payment problem is only ever shown on your member page, never as a link in this chat.`;
      }
      return "Connected as the shop owner. Held offers and large collections will ask you here with Approve and Decline buttons. Send “pending” any time.";
    }
    const m = text.match(/^link\s+(subscriber|owner):(\S+)$/i);
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
    if (!msg.party) return "Hi, this is Kept. This chat isn't connected yet: open your member page (or your shop's Messages page) and tap the Telegram button.";
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
