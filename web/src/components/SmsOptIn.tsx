import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";

/** Texts before each renewal: number → texted 6-digit code → on. Nothing is sent until the code comes back. */
export function SmsOptIn({ memberRef, sms, onChange }: { memberRef: string; sms: { ready: boolean; linked: string[]; pending?: string | null }; onChange: () => void | Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(sms.pending ?? null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const base = `/ui/manage/${memberRef}/sms`;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!sms.ready) return null;
  if (sms.linked.length)
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded border border-paid px-2 py-1 font-medium text-paid">Texts on: {sms.linked.join(", ")}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { toast.success((await api.post<{ message: string }>(`${base}/stop`, {})).message); await onChange(); })}>
          Stop texts
        </Button>
      </div>
    );
  return (
    <div className="mt-4 border-t border-dashed border-rule pt-4">
      <p className="m-0 mb-2 text-sm font-medium">Or by text message</p>
      {sentTo ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { toast.success((await api.post<{ message: string }>(`${base}/verify`, { code })).message); setSentTo(null); setCode(""); await onChange(); }); }}>
          <div className="grid gap-1">
            <Label htmlFor="sms-code">Code sent to {sentTo}</Label>
            <Input id="sms-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="w-32" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
          </div>
          <Button type="submit" disabled={busy || code.length !== 6}>Turn on texts</Button>
          <Button type="button" variant="ghost" onClick={() => setSentTo(null)}>Use another number</Button>
        </form>
      ) : (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(async () => { setSentTo((await api.post<{ to: string }>(`${base}/start`, { phone, consent })).to); }); }}>
          <div className="grid gap-1">
            <Label htmlFor="sms-phone">Mobile number, with country code</Label>
            <Input id="sms-phone" type="tel" autoComplete="tel" placeholder="+65 8123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm text-ink-2">
            <Checkbox checked={consent} onCheckedChange={(c) => setConsent(c === true)} className="mt-0.5 size-5" aria-labelledby="sms-consent" />
            <span id="sms-consent">Text me before each renewal and if a payment has a problem. About one text a cycle; reply STOP to opt out. Carrier rates may apply.</span>
          </label>
          <div>
            <Button type="submit" variant="outline" disabled={busy || !consent || !phone}>Text me a code</Button>
          </div>
        </form>
      )}
      <p className="m-0 mt-2 min-h-5 text-sm text-ink-2" role="status" aria-live="polite">{msg}</p>
    </div>
  );
}
