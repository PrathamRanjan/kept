import { Bot, Database, Landmark, MessageSquareText, Wrench, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Spec A5.3: the AI work rail. Each tool call the model made, as it happened: name, a one-line summary of the
 * arguments, how long it took, and a one-line result. Who answered each call is labelled: Kept's own records,
 * PayPal's MCP server, or a Kept action through the member's gate.
 */
export interface RailStep {
  n: number;
  kind: "tool" | "model" | "answer" | "error";
  name: string;
  source?: "kept" | "paypal_mcp" | "kept_action";
  args?: string;
  summary: string;
  ms: number;
}
export interface Fact { id: string; text: string }
export interface Sentence { text: string; facts: string[]; grounded: boolean }

const SOURCE: Record<string, { label: string; icon: typeof Database; cls: string }> = {
  kept: { label: "Kept records", icon: Database, cls: "text-stamp" },
  paypal_mcp: { label: "PayPal MCP", icon: Landmark, cls: "text-paid" },
  kept_action: { label: "Kept action, gated", icon: Wrench, cls: "text-pause" },
};

export function WorkRail({ steps, running, title = "AI work" }: { steps: RailStep[]; running: boolean; title?: string }) {
  const tools = steps.filter((s) => s.kind === "tool").length;
  return (
    <aside aria-label={title} className="rounded-lg border border-rule bg-paper p-3">
      <p className="m-0 flex items-center gap-2 text-sm font-semibold">
        <Bot className="size-4 text-stamp" aria-hidden="true" />
        {title}
        <span className="font-normal text-ink-2">{running ? "working…" : steps.length ? `${tools} tool call${tools === 1 ? "" : "s"}` : "nothing yet"}</span>
      </p>
      {steps.length === 0 && !running && <p className="mt-2 mb-0 text-sm text-ink-2">Ask a question and each step the model takes shows here as it happens.</p>}
      <ol className="mt-2 mb-0 list-none space-y-2 p-0" aria-live="polite">
        {steps.map((s) => {
          const src = s.source ? SOURCE[s.source] : null;
          const Icon = s.kind === "error" ? XCircle : s.kind === "tool" ? src?.icon ?? Wrench : s.kind === "answer" ? MessageSquareText : Bot;
          return (
            <li key={s.n} className="rounded-md border border-rule bg-card p-2 text-sm">
              <div className="flex items-center gap-2">
                <Icon className={cn("size-4 shrink-0", s.kind === "error" ? "text-fail" : src?.cls ?? "text-ink-2")} aria-hidden="true" />
                <span className="font-mono font-medium break-all">{s.kind === "model" ? `model: ${s.name}` : s.name}</span>
                <span className="ml-auto shrink-0 text-xs text-ink-2 num">{s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : `${s.ms} ms`}</span>
              </div>
              {s.args && s.args !== "{}" && <p className="m-0 mt-1 font-mono text-xs break-all text-ink-2">{s.args}</p>}
              <p className="m-0 mt-1 text-ink-2">{src ? `${src.label}: ` : ""}{s.summary}</p>
            </li>
          );
        })}
        {running && <li className="animate-pulse rounded-md border border-dashed border-rule p-2 text-sm text-ink-2">Waiting for the next step…</li>}
      </ol>
    </aside>
  );
}

/** The answer, each sentence followed by the facts it cites; a sentence with no valid citation says so. */
export function CitedAnswer({ sentences, facts, idPrefix = "fact" }: { sentences: Sentence[]; facts: Fact[]; idPrefix?: string }) {
  const used = new Set(sentences.flatMap((s) => s.facts));
  return (
    <div>
      <p className="m-0">
        {sentences.map((s, i) => (
          <span key={i}>
            {s.text}
            {s.facts.map((f) => (
              <sup key={f} className="ml-0.5">
                <a href={`#${idPrefix}-${f}`} className="font-mono text-xs" aria-label={`source ${f}`}>{f}</a>
              </sup>
            ))}
            {!s.grounded && <sup className="ml-0.5 text-xs text-fail">no source</sup>}{" "}
          </span>
        ))}
      </p>
      {used.size > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-ink-2">Sources ({used.size})</summary>
          <ul className="mt-1 mb-0 list-none space-y-1 p-0">
            {facts.filter((f) => used.has(f.id)).map((f) => (
              <li key={f.id} id={`${idPrefix}-${f.id}`}><span className="font-mono text-xs">{f.id}</span> {f.text}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
