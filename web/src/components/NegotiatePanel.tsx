import { useState } from "react";
import { Bot, Scale, Store } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { VoiceButton } from "@/components/VoiceButton";
import { api, ApiError, newKey } from "@/lib/api";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

interface Line { who: "member" | "shop" | "referee"; move: number | null; kind: string; text: string; offer?: string | null }
interface Out { status: "agreed" | "agreed_sample" | "no_deal" | "held" | "offer_open"; transcript: Line[]; offer: { offer_id: string; label?: string; message?: string } | null; agreed: { key: string; label: string } | null; model: string | null; moves: { member: number; shop: number } }

/**
 * Kept per-app item 1: the member's assistant and the shop's agent talk, two moves each, refereed by code. The
 * transcript is in the member's language. Nothing changes here: an agreed offer appears as the ordinary offer card
 * above, which the member takes or declines; "Cancel now" is the ordinary one-step cancel.
 */
export function NegotiatePanel({ memberRef, shop, sample, onChanged }: { memberRef: string; shop: string; sample: boolean; onChanged: () => void }) {
  const { lang, t } = useT();
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Out | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOut(null);
    try {
      const r = await api.post<Out>(`/ui/manage/${memberRef}/negotiate`, { words, key: newKey() });
      setOut(r);
      if (r.status === "agreed" || r.status === "offer_open") onChanged();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : t("n.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelNow() {
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>(`/ui/manage/${memberRef}/cancel`, { reason: words, hear_offer: false, key: newKey() });
      toast.success(r.message);
      onChanged();
    } catch (x) {
      toast.error(x instanceof ApiError ? x.message : t("n.failed"));
    } finally {
      setBusy(false);
    }
  }

  const who = (w: Line["who"]) => (w === "member" ? t("n.member") : w === "shop" ? t("n.shop", { shop }) : t("n.referee"));
  const Icon = (w: Line["who"]) => (w === "member" ? Bot : w === "shop" ? Store : Scale);

  return (
    <div className="pt-5" data-testid="negotiate">
      <h3 className="m-0 text-lg font-semibold">{t("n.title")}</h3>
      <p className="mt-1 max-w-[66ch] text-sm text-ink-2">{t("n.intro", { shop })}</p>
      <form onSubmit={start} className="mt-3 grid gap-2">
        <Label htmlFor="negotiate-words">{t("n.label")}</Label>
        <div className="flex items-start gap-2">
          <Textarea id="negotiate-words" value={words} onChange={(e) => setWords(e.target.value)} maxLength={400} rows={2} placeholder={t("n.ph")} className="flex-1" />
          {!sample && <VoiceButton onText={(x) => setWords(x)} memberRef={memberRef} />}
        </div>
        <div>
          <Button type="submit" variant="outline" disabled={busy}>{busy ? t("n.talking") : t("n.start")}</Button>
        </div>
      </form>
      {err && <p role="alert" className="mt-2 text-sm text-fail">{err}</p>}
      {out && out.transcript.length > 0 && (
        <section className="mt-4" aria-labelledby="negotiate-t" aria-live="polite">
          <h4 id="negotiate-t" className="m-0 text-base font-semibold">{t("n.transcript")}</h4>
          <ol className="mt-2 grid list-none gap-2 p-0">
            {out.transcript.map((l, i) => {
              const I = Icon(l.who);
              return (
                <li key={i} className={cn("flex gap-2 rounded-lg p-3 text-sm", l.who === "referee" ? "border border-dashed border-rule text-ink-2" : l.who === "member" ? "bg-stamp-wash" : "bg-muted")}>
                  <I className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span><b>{who(l.who)}{l.move ? ` · ${l.move}/2` : ""}:</b> {l.text}</span>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-ink-2">{out.model ? t("n.byModel", { model: out.model }) : t("n.byCode")}</p>
          {(out.status === "agreed" || out.status === "agreed_sample") && (
            <p role="status" className="mt-2 rounded-lg bg-paid-wash p-3 font-medium">{t("n.agreed", { label: lang === "en" ? out.agreed?.label ?? "" : out.transcript.filter((l) => l.who === "shop" && l.offer).at(-1)?.text ?? "" })}</p>
          )}
          {(out.status === "no_deal" || out.status === "held") && !sample && (
            <div className="mt-3 rounded-lg border border-rule p-3">
              <p className="m-0">{t("n.noDeal")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" onClick={cancelNow} disabled={busy}>{t("n.cancelNow")}</Button>
                <Button variant="ghost" onClick={() => { setOut(null); toast.message(t("n.kept")); }}>{t("n.keep")}</Button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
