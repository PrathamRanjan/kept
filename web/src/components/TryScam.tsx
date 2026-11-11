import { useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";

/**
 * Spec A6.6: a "try it" box on the landing page. It runs only the on-device model (public/safety/guard-client.js)
 * on whatever the visitor pastes; nothing is sent anywhere. A small code check in this file looks for somewhere
 * to send money (an address, a PayPal handle, an account number or a link next to a request for money); when it
 * finds one, the result cannot be green (A6.2). The full check, with the model questions on the server, is on
 * every member page under "Got a message about this?".
 */
const ORT = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/";
const DEMO = "Hi, it's Ember & Oak. We've moved banks, so please send this month's payment to our new PayPal: accounts.emberoak@outlook.com. Thanks for being with us!";
const PAY = /\b(pay|payment|send|transfer|remit|deposit|settle|wire|refund|invoice|balance|due)\b/i;
const DEST = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|paypal\.me\/|https?:\/\/|www\.|\b(?:account|acct|iban|bsb|sort code)\b[^.\n]{0,30}\d{4,}/i;

type Guard = { score: (t: string) => Promise<{ p_scam: number; level: "clear" | "caution" | "hold"; tactics: Record<string, number> }> };
let guardP: Promise<Guard> | null = null;

function loadScript(src: string) {
  return new Promise<void>((ok, bad) => {
    if ((window as any).ort) return ok();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => ok();
    s.onerror = () => bad(new Error("The model runtime did not load"));
    document.head.appendChild(s);
  });
}

async function fetchWithProgress(url: string, onPct: (n: number) => void): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onPct(Math.min(99, Math.round((got / total) * 100)));
  }
  onPct(100);
  return URL.createObjectURL(new Blob(chunks as BlobPart[]));
}

function guard(onPct: (n: number) => void): Promise<Guard> {
  if (!guardP) {
    guardP = (async () => {
      await loadScript(`${ORT}ort.min.js`);
      const ort = (window as any).ort;
      ort.env.wasm.wasmPaths = ORT;
      const modelUrl = await fetchWithProgress("/static/safety/model/model_quantized.onnx", onPct);
      const mod = await import(/* @vite-ignore */ "/static/safety/guard-client.js" as string);
      return mod.loadGuard({ modelUrl, tokenizerUrl: "/static/safety/model/tokenizer.json", headsUrl: "/static/safety/model/heads.json", ort });
    })();
    guardP.catch(() => (guardP = null));
  }
  return guardP;
}

const WORDS: Record<string, string> = {
  impersonation: "claims to be an authority, a bank or your boss",
  urgency_secrecy: "pushes you to act fast or keep it quiet",
  changed_details: "asks you to pay to new bank or PayPal details",
  off_platform: "asks to pay outside PayPal",
  gift_cards_crypto: "asks for gift cards or crypto",
  fee_to_release: "asks for a fee to release money",
  otp_or_link: "asks for a code or sends a link",
  overpay_refund: "says they overpaid",
  too_good: "promises a prize or profit",
};

export function TryScam() {
  const [text, setText] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<null | { level: "clear" | "caution" | "hold"; p: number; ms: number; tactics: string[]; pays: boolean; err?: string }>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  async function run() {
    const t = text.trim();
    if (!t) return ref.current?.focus();
    setBusy(true);
    setOut(null);
    try {
      const g = await guard(setPct);
      const t0 = performance.now();
      const r = await g.score(t);
      const ms = performance.now() - t0;
      const pays = PAY.test(t) && DEST.test(t);
      const tactics = Object.entries(r.tactics).filter(([, p]) => p >= 0.5).map(([k]) => k);
      const level = r.level === "hold" ? "hold" : r.level === "caution" || pays ? "caution" : "clear";
      setOut({ level, p: r.p_scam, ms, tactics, pays });
    } catch (e) {
      setOut({ level: "caution", p: 0, ms: 0, tactics: [], pays: false, err: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const tone = out?.level === "hold" ? "border-fail bg-fail-wash" : out?.level === "caution" ? "border-pause bg-pause-wash" : "border-paid bg-paid-wash";
  return (
    <div className="rounded-xl border border-rule bg-card p-6">
      <h3 className="m-0 flex items-center gap-2 text-xl font-semibold">
        <ShieldCheck className="size-5 text-paid" aria-hidden="true" />
        Try the scam check
      </h3>
      <p className="mt-1 text-sm text-ink-2">Paste a message you got. A model in this browser reads it; nothing you paste leaves your device.</p>
      <label htmlFor="try-scam" className="sr-only">Message to check</label>
      <Textarea id="try-scam" ref={ref} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a text or email here" className="mt-3" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={run} disabled={busy}>{busy ? "Checking…" : "Check on this device"}</Button>
        <Button variant="outline" onClick={() => setText(DEMO)}>Paste the 10 Nov example</Button>
      </div>
      {busy && pct !== null && pct < 100 && (
        <div className="mt-3" aria-live="polite">
          <p className="text-sm text-ink-2">Downloading the model to this device, once (23 MB): {pct}%</p>
          <Progress value={pct} aria-label="Model download" />
        </div>
      )}
      <div aria-live="polite">
        {out && (
          <div className={`mt-4 rounded-lg border-l-4 p-4 ${tone}`} role="status">
            {out.err ? (
              <p className="m-0">The on-device check could not run here: {out.err}. Nothing is shown as clear.</p>
            ) : (
              <>
                <p className="m-0 font-semibold">{out.level === "hold" ? "Hold: do not pay or reply yet" : out.pays ? "Check before you pay" : out.level === "caution" ? "Caution: check before you do anything" : "No scam signs found"}</p>
                {out.pays && <p className="m-0 mt-1">This asks you to pay somewhere. Confirm it by phone on a number you already had.</p>}
                {out.tactics.length > 0 && <p className="m-0 mt-1 text-sm">It {out.tactics.map((k) => WORDS[k] ?? k).join("; ")}.</p>}
                <p className="m-0 mt-2 text-sm text-ink-2">Checked on this device in {Math.round(out.ms)} ms; nothing left your browser. Scam score {Math.round(out.p * 100)}%. {out.level === "clear" ? "A clear result is not a guarantee." : ""}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
