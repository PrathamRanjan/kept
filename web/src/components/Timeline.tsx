import { Bot, Landmark, Scale, Sparkles, User } from "lucide-react";
import { fmtDate } from "@/lib/format";
import type { TimelineRun, TimelineStep } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useT, type T } from "@/i18n";

const WHO: Record<TimelineStep["who"], { icon: typeof Bot; label: string; cls: string }> = {
  AI: { icon: Sparkles, label: "AI proposed", cls: "text-stamp border-stamp/40 bg-stamp-wash" },
  Rule: { icon: Scale, label: "Rule decided", cls: "text-ink border-ink/30 bg-muted" },
  PayPal: { icon: Landmark, label: "PayPal did", cls: "text-paid border-paid/40 bg-paid-wash" },
  Person: { icon: User, label: "Person", cls: "text-ink-2 border-rule bg-card" },
  Agent: { icon: Bot, label: "AI assistant", cls: "text-ink-2 border-rule bg-card" },
};

/** "AI" and "PayPal" are names and stay as they are; the other chips are words. */
const chip = (t: T, who: TimelineStep["who"]) => (who === "Rule" || who === "Person" || who === "Agent" ? t(`tl.${who}`) : who);

export function WhoChip({ who }: { who: TimelineStep["who"] }) {
  const { t } = useT();
  const w = WHO[who];
  const Icon = w.icon;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium", w.cls)}>
      <Icon className="size-3.5" aria-hidden="true" />
      {chip(t, who)}
    </span>
  );
}

/** The three-part trust pattern as a legend: shown wherever money can move. */
export function TrustStrip({ className }: { className?: string }) {
  const { t } = useT();
  return (
    <ol className={cn("grid list-none gap-2 p-0 m-0 sm:grid-cols-3", className)} aria-label={t("tl.trust")}>
      <li className="rounded-lg border border-rule bg-card p-3">
        <WhoChip who="AI" />
        <p className="mt-2 text-sm text-ink-2">{t("tl.ai")}</p>
      </li>
      <li className="rounded-lg border border-rule bg-card p-3">
        <WhoChip who="Rule" />
        <p className="mt-2 text-sm text-ink-2">{t("tl.rule")}</p>
      </li>
      <li className="rounded-lg border border-rule bg-card p-3">
        <WhoChip who="PayPal" />
        <p className="mt-2 text-sm text-ink-2">{t("tl.pp")}</p>
      </li>
    </ol>
  );
}

const GATE: Record<string, "tl.held" | "tl.refused"> = { held: "tl.held", denied: "tl.refused", dry_run_refused: "tl.refused" };

export function Timeline({ runs, empty }: { runs: TimelineRun[]; empty?: string }) {
  const { t, lang } = useT();
  if (!runs.length) return <p className="text-sm text-ink-2">{empty ?? t("tl.empty")}</p>;
  return (
    <>
    {lang !== "en" && <p className="mt-0 text-sm text-ink-2" data-testid="history-recorded">{t("tl.recorded")}</p>}
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
                  {s.gate && GATE[s.gate] && <span className="ml-1 font-medium text-pause">({t(GATE[s.gate])})</span>}
                  {s.policy && <span className="ml-1 text-ink-2">· {s.policy}</span>}
                  {(s.pp_debug_id || s.pp_request_id) && (
                    <span className="mt-0.5 block truncate font-mono text-xs text-ink-2">{s.pp_debug_id ? t("tl.debug", { id: s.pp_debug_id }) : t("tl.req", { id: String(s.pp_request_id) })}</span>
                  )}
                </span>
              </li>
            ))}
            {!r.steps.length && <li className="text-sm text-ink-2">{t("tl.none")}</li>}
          </ol>
        </li>
      ))}
    </ol>
    </>
  );
}
