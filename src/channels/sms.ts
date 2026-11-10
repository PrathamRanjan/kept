/**
 * SMS through Twilio's Messaging API. A number is linked only after its owner proves it: Kept texts a 6-digit code
 * (10 minutes, 5 tries, 3 codes an hour) and the person types it back on their member page or the shop's Messages page.
 * Texts carry a link to the member page instead of buttons; replies arrive at /webhooks/twilio, signature-checked.
 * STOP is honoured by Twilio itself; Kept also drops the link when told the number has opted out (error 21610).
 */
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { KeptError } from "../store.js";
import { channelFetch, link, send, type Party } from "./index.js";

const tw = () => config.channels.twilio;
export const smsReady = () => Boolean(tw().accountSid && (tw().authToken || (tw().apiKeySid && tw().apiKeySecret)) && (tw().from || tw().messagingServiceSid));

const E164 = /^\+[1-9]\d{7,14}$/;
/** "+65 8148 0996", "(415) 555-0100" with a country code, etc. → "+6581480996". */
export function normalisePhone(raw: string): string | null {
  const s = String(raw ?? "").trim().replace(/[\s().-]/g, "").replace(/^00/, "+");
  return E164.test(s) ? s : null;
}
export const maskPhone = (p: string) => `${p.slice(0, 3)}••••${p.slice(-3)}`;

export class TwilioError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number) {
    super(message);
  }
}

/** Sends one text; returns Twilio's message SID. */
export async function sendSms(to: string, body: string): Promise<string> {
  if (!smsReady()) throw new TwilioError("SMS is not configured on this server", null, 0);
  const c = tw();
  const user = c.apiKeySid && c.apiKeySecret ? c.apiKeySid : c.accountSid;
  const pass = c.apiKeySid && c.apiKeySecret ? c.apiKeySecret : c.authToken;
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 1500) });
  if (c.messagingServiceSid) form.set("MessagingServiceSid", c.messagingServiceSid);
  else form.set("From", c.from);
  const res = await channelFetch()(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new TwilioError(`Twilio: ${data.message ?? res.status}`, data.code ?? null, res.status);
  return String(data.sid ?? "");
}

const key = (party: Party, partyId: string) => `smslink:${party}:${partyId}`;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");
interface Pending { phone: string; code: string; exp: number; tries: number; sent: number[] }

/** Step 1: text a code to the number. Returns the masked number. */
export async function startSmsLink(party: Party, partyId: string, rawPhone: string, consent: boolean): Promise<{ to: string }> {
  if (!smsReady()) throw new KeptError("Text messages aren't set up on this server yet.", "sms_not_configured", 409);
  if (!consent) throw new KeptError("Tick the box to agree to texts first.", "consent_required", 422);
  const phone = normalisePhone(rawPhone);
  if (!phone) throw new KeptError("Enter the number with its country code, for example +65 8123 4567.", "invalid_phone", 422);
  const db = await getDb();
  const row = (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key(party, partyId)])).rows[0];
  const prev = row ? (JSON.parse(row.value) as Pending) : null;
  const sent = (prev?.sent ?? []).filter((t) => t > Date.now() - 3600_000);
  if (sent.length >= 3) throw new KeptError("Three codes were sent in the last hour. Try again later.", "rate_limited", 429);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const v: Pending = { phone, code: hash(code), exp: Date.now() + 10 * 60_000, tries: 0, sent: [...sent, Date.now()] };
  await db.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key(party, partyId), JSON.stringify(v)]);
  try {
    await sendSms(phone, `Kept: your code is ${code}. It lasts 10 minutes. Kept never asks for this code anywhere else. Reply STOP to opt out.`);
  } catch (e) {
    throw new KeptError(e instanceof TwilioError && e.code === 21211 ? "That number can't receive texts." : "The code couldn't be sent. Check the number and try again.", "sms_failed", 502);
  }
  return { to: maskPhone(phone) };
}

/** Step 2: the code comes back; the number is linked and gets a confirmation text. */
export async function verifySmsLink(party: Party, partyId: string, code: string): Promise<{ phone: string }> {
  const db = await getDb();
  const k = key(party, partyId);
  const row = (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [k])).rows[0];
  const v = row ? (JSON.parse(row.value) as Pending) : null;
  if (!v || !v.code || v.exp < Date.now()) throw new KeptError("That code has expired. Send a new one.", "code_expired", 410);
  if (v.tries >= 5) throw new KeptError("Too many wrong codes. Send a new one.", "too_many_tries", 429);
  const ok = timingSafeEqual(Buffer.from(hash(String(code ?? "").trim())), Buffer.from(v.code));
  if (!ok) {
    await db.query("UPDATE settings SET value = $2 WHERE key = $1", [k, JSON.stringify({ ...v, tries: v.tries + 1 })]);
    throw new KeptError("That code isn't right.", "wrong_code", 422);
  }
  await db.query("UPDATE settings SET value = $2 WHERE key = $1", [k, JSON.stringify({ ...v, code: "", exp: 0 })]);
  await link("sms", v.phone, party, partyId);
  await send({ channel: "sms", address: v.phone, body: party === "owner" ? "Kept: texts are on. Held offers and large collections will text you with a link to approve or decline." : "Kept: texts are on. You'll get a note before each renewal and if a payment has a problem, each with a link to your member page. Reply STOP to opt out." }, db);
  return { phone: maskPhone(v.phone) };
}

/** The masked number a still-valid code was sent to, so a reloaded page can ask for it. */
export async function smsPending(party: Party, partyId: string): Promise<string | null> {
  const row = (await (await getDb()).query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key(party, partyId)])).rows[0];
  const v = row ? (JSON.parse(row.value) as Pending) : null;
  return v && v.code && v.exp > Date.now() && v.tries < 5 ? maskPhone(v.phone) : null;
}

export async function smsLinks(party: Party, partyId: string): Promise<string[]> {
  const db = await getDb();
  return (await db.query<{ address: string }>("SELECT address FROM party_links WHERE channel = 'sms' AND party = $1 AND party_id = $2", [party, partyId])).rows.map((r) => maskPhone(r.address));
}

export async function stopSms(party: Party, partyId: string): Promise<void> {
  const db = await getDb();
  await db.query("DELETE FROM party_links WHERE channel = 'sms' AND party = $1 AND party_id = $2", [party, partyId]);
}

/** Twilio's X-Twilio-Signature: HMAC-SHA1 of the full URL followed by each POST field name and value, sorted by name. */
export function twilioSignatureValid(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!tw().authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", tw().authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
