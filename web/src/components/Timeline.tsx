import { Bot, Landmark, Scale, Sparkles, User } from "lucide-react";
import { fmtDate } from "@/lib/format";
import type { TimelineRun, TimelineStep } from "@/lib/types";
import { cn } from "@/lib/utils";

const WHO: Record<TimelineStep["who"], { icon: typeof Bot; label: string; cls: string }> = {
  AI: { icon: Sparkles, label: "AI proposed", cls: "text-stamp border-stamp/40 bg-stamp-wash" },
  Rule: { icon: Scale, label: "Rule decided", cls: "text-ink border-ink/30 bg-muted" },
  PayPal: { icon: Landmark, label: "PayPal did", cls: "text-paid border-paid/40 bg-paid-wash" },
  Person: { icon: User, label: "Person", cls: "text-ink-2 border-rule bg-card" },
  Agent: { icon: Bot, label: "AI assistant", cls: "text-ink-2 border-rule bg-card" },
};

export function WhoChip({ who }: { who: TimelineStep["who"] }) {
  const w = WHO[who];
  const Icon = w.icon;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium", w.cls)}>
      <Icon className="size-3.5" aria-hidden="true" />
      {who}
    </span>
  );
}

/** The three-part trust pattern as a legend: shown wherever money can move. */
export function TrustStrip({ className }: { className?: string }) {
  return (
    <ol className={cn("grid list-none gap-2 p-0 m-0 sm:grid-cols-3", className)} aria-label="Who decides what">
      <li className="rounded-lg border border-rule bg-card p-3">
        <WhoChip who="AI" />
        <p className="mt-2 text-sm text-ink-2">Reads plain words, labels a reason, words a message. Never sets a price.</p>
      </li>
      <li className="rounded-lg border border-rule bg-card p-3">
        <WhoChip who="Rule" />
        <p className="mt-2 text-sm text-ink-2">Code applies the owner's rules and limits. A cancel is always allowed.</p>
      </li>
      <li className="rounded-lg border border-rule bg-card p-3">
        <WhoChip who="PayPal" />
        <p className="mt-2 text-sm text-ink-2">Moves the money. Kept only believes what PayPal reads back.</p>
      </li>
    </ol>
  );
}

const GATE: Record<string, string> = { allowed: "allowed", held: "held for owner", denied: "refused", dry_run_refused: "refused" };

export function Timeline({ runs, empty = "Nothing has happened yet." }: { runs: TimelineRun[]; empty?: string }) {
  if (!runs.length) return <p className="text-sm text-ink-2">{empty}</p>;
  return (
    <ol className="m-0 list-none space-y-5 p-0">
      {runs.map((r) => (
        <li key={r.id} className="rounded-lg border border-rule bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-dashed border-rule px-4 py-2.5">
            <p className="m-0 font-medium first-letter:uppercase">{r.subject}</p>
            <time className="text-sm text-ink-2" dateTime={r.at}>
              {fmtDate(r.at, { time: true })}
            </time>
          </div>
          <ol className="m-0 list-none space-y-2 px-4 py-3">
            {r.steps.map((s) => (
              <li key={s.n} className="flex items-start gap-2.5 text-sm">
                <WhoChip who={s.who} />
                <span className="min-w-0 flex-1 pt-0.5">
                  {s.text}
                  {s.gate && GATE[s.gate] && s.gate !== "allowed" && <span className="ml-1 font-medium text-pause">({GATE[s.gate]})</span>}
                  {s.policy && <span className="ml-1 text-ink-2">· {s.policy}</span>}
                  {(s.pp_debug_id || s.pp_request_id) && (
                    <span className="mt-0.5 block truncate font-mono text-xs text-ink-2">{s.pp_debug_id ? `PayPal debug ${s.pp_debug_id}` : `request ${s.pp_request_id}`}</span>
                  )}
                </span>
              </li>
            ))}
            {!r.steps.length && <li className="text-sm text-ink-2">No steps recorded.</li>}
          </ol>
        </li>
      ))}
    </ol>
  );
}
