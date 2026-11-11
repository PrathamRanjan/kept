import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VoiceButton } from "@/components/VoiceButton";
import { ApiError, streamPost } from "@/lib/api";
import { CitedAnswer, WorkRail, type Fact, type RailStep, type Sentence } from "@/components/WorkRail";

/**
 * Spec B5 differentiator 1: "Be the member's assistant". The visitor types what they'd say to their own AI
 * assistant; a model acting for the member calls Kept's public MCP tools; the rail shows every call, the rule that
 * allowed a change, and PayPal's read-back, which code fetches after every change.
 */
const SUGGEST = ["What's my next payment?", "Pause my coffee for a month", "Resume it please", "Skip the next one", "Cancel it, I'm moving"];

export function AssistantPanel({ memberRef, sample, initial, onChanged }: { memberRef: string; sample: boolean; initial?: string | null; onChanged: () => void }) {
  const [msg, setMsg] = useState(initial ?? "");
  const [steps, setSteps] = useState<RailStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ sentences?: Sentence[]; facts?: Fact[]; text?: string; failed?: boolean; model?: string; ms?: number; mandate?: string; readBack?: string | null } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initial) {
      setMsg(initial);
      ref.current?.focus();
    }
  }, [initial]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!msg.trim()) return ref.current?.focus();
    setBusy(true);
    setSteps([]);
    setOut(null);
    try {
      let done = false;
      await streamPost(`/ui/manage/${memberRef}/assistant/stream`, { message: msg }, (ev, data) => {
        if (ev === "step") setSteps((x) => [...x, data]);
        if (ev === "answer") (done = true), setOut({ sentences: data.sentences, facts: data.facts, model: data.model, ms: data.ms, mandate: data.mandate });
        if (ev === "failed") (done = true), setOut({ text: data.message, failed: true });
      });
      if (!done) setOut({ text: "The assistant stopped part way. Check the steps for anything it changed.", failed: true });
    } catch (err) {
      setOut({ text: err instanceof ApiError ? err.message : "The assistant couldn't run.", failed: true });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <section id="assistant" className="mt-8 scroll-mt-20 rounded-xl border border-rule bg-card p-6" aria-labelledby="assistant-h">
      <h2 id="assistant-h" className="m-0 flex items-center gap-2 text-2xl font-bold">
        <Bot className="size-6 text-stamp" aria-hidden="true" />
        Be the member's assistant
      </h2>
      <p className="mt-1 max-w-[66ch] text-ink-2">Type what you would say to your own AI assistant. A model acting for you calls this shop's public MCP tools, the same ones Claude or ChatGPT would use. Every call is listed, with the rule that allowed it and what PayPal says afterwards.{sample ? " This member is a labelled sample with no PayPal subscription, so the assistant can read but any change is refused." : ""}</p>
      <form onSubmit={send} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="assistant-msg" className="sr-only">What should the assistant do?</label>
        <Input id="assistant-msg" ref={ref} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Pause my coffee for a month" className="h-11 flex-1" maxLength={400} />
        <VoiceButton onText={(t) => setMsg(t)} memberRef={memberRef} label="Tell the assistant by voice" />
        <Button type="submit" disabled={busy || !msg.trim()}>{busy ? "Working…" : "Send to the assistant"}</Button>
      </form>
      <div className="mt-2 flex flex-wrap gap-2">
        {SUGGEST.map((x) => (
          <button key={x} type="button" className="min-h-9 rounded-full border border-rule px-3 text-sm text-ink-2 hover:bg-muted" onClick={() => setMsg(x)}>{x}</button>
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_minmax(280px,380px)]">
        <div aria-live="polite">
          {out && !out.failed && out.sentences && (
            <div className="rounded-lg bg-stamp-wash p-4">
              <p className="m-0 text-sm font-semibold">Your assistant</p>
              <div className="mt-1"><CitedAnswer sentences={out.sentences} facts={out.facts ?? []} idPrefix="afact" /></div>
              <p className="mt-2 mb-0 text-xs text-ink-2">By {out.model}{out.ms ? ` in ${(out.ms / 1000).toFixed(1)} s` : ""}. {out.readBack ? <>The model chose the tools; Kept's rules and gate decided; PayPal made the change, and code read it back: {out.readBack}.</> : sample ? "A sample member: nothing was sent to PayPal." : "Nothing was changed."}</p>
              {out.mandate && <p className="mt-1 mb-0 text-xs text-ink-2">Allowed by signed mandate <a className="font-mono underline" href={`/api/public/mandate/${out.mandate}`} target="_blank" rel="noreferrer">{out.mandate}</a>: its scope came from your words, and code checked it before each change.</p>}
            </div>
          )}
          {out?.failed && <div role="alert" className="rounded-lg border border-rule p-4"><p className="m-0 font-semibold">The assistant stopped</p><p className="mt-1 mb-0">{out.text}</p></div>}
        </div>
        <WorkRail steps={steps} running={busy} title="Assistant's tool calls" />
      </div>
    </section>
  );
}
