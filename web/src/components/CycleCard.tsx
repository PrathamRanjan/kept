import { fmtDate, fmtMoney } from "@/lib/format";
import type { CycleCardData, Stamp, StampKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useT, type T } from "@/i18n";

const WORDS: Record<StampKind, "c.paid" | "c.discount" | "c.skipped" | "c.paused" | "c.failed" | "c.upcoming"> = {
  paid: "c.paid",
  discount: "c.discount",
  skipped: "c.skipped",
  paused: "c.paused",
  failed: "c.failed",
  upcoming: "c.upcoming",
};

/** One stamp. Drawn in SVG so it stays crisp at any size and needs no colour to be understood. */
export function StampMark({ kind, next, size = 28, animate = false, delay = 0 }: { kind: StampKind; next?: boolean; size?: number; animate?: boolean; delay?: number }) {
  const c = size / 2;
  const r = c - 2;
  const color =
    kind === "failed" ? "var(--fail)" : kind === "paused" ? "var(--pause)" : kind === "skipped" ? "var(--ink-2)" : kind === "upcoming" ? (next ? "var(--stamp)" : "var(--ink-2)") : "var(--stamp)";
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={cn("shrink-0", animate && "stamp-in")}
      style={animate ? { animationDelay: `${delay}ms` } : undefined}
    >
      {kind === "paid" && (
        <>
          <circle cx={c} cy={c} r={r} fill={color} />
          <path d={`M${c - r * 0.42} ${c + 0.5} l${r * 0.3} ${r * 0.3} l${r * 0.55} -${r * 0.62}`} stroke="var(--card-stock)" strokeWidth={size / 11} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === "discount" && (
        <>
          <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={size / 14} />
          <path d={`M${c} ${c - r} A${r} ${r} 0 0 0 ${c} ${c + r} Z`} fill={color} />
        </>
      )}
      {kind === "skipped" && (
        <>
          <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={size / 14} />
          <line x1={c - r * 0.62} y1={c + r * 0.62} x2={c + r * 0.62} y2={c - r * 0.62} stroke={color} strokeWidth={size / 12} strokeLinecap="round" />
        </>
      )}
      {kind === "paused" && <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={size / 12} strokeDasharray={`${size / 7} ${size / 10}`} />}
      {kind === "failed" && (
        <>
          <circle cx={c} cy={c} r={r} fill="var(--fail-wash)" stroke={color} strokeWidth={size / 12} />
          <line x1={c} y1={c - r * 0.5} x2={c} y2={c + r * 0.12} stroke={color} strokeWidth={size / 10} strokeLinecap="round" />
          <circle cx={c} cy={c + r * 0.45} r={size / 20} fill={color} />
        </>
      )}
      {kind === "upcoming" && (
        <>
          {next && <circle cx={c} cy={c} r={r} fill="var(--stamp-wash)" />}
          <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={next ? size / 12 : size / 18} />
        </>
      )}
    </svg>
  );
}

function stampLabel(s: Stamp, currency: string, t: T): string {
  const what = s.kind === "upcoming" ? (s.next ? t("c.nextPay") : t("c.upcoming")) : s.scheduled ? `${t(WORDS[s.kind])} ${t("c.scheduled")}` : t(WORDS[s.kind]);
  return `${what}, ${fmtDate(s.date, { year: true })}${s.amount ? `, ${fmtMoney(s.amount, currency)}` : ""}`;
}

/**
 * The cycle card: Kept's signature. One stamp per billing cycle, oldest left. A cancel is a clean closed end,
 * not a red error. Screen readers get the same story as a list.
 */
export function CycleCard({ card, currency = "USD", size = "md", animate = false, caption, className }: { card: CycleCardData; currency?: string; size?: "sm" | "md" | "lg"; animate?: boolean; caption?: string; className?: string }) {
  const px = size === "lg" ? 40 : size === "sm" ? 18 : 28;
  const showDates = size !== "sm";
  const { t } = useT();
  if (!card.stamps.length && !card.end) return <p className="text-sm text-ink-2">{t("c.none")}</p>;
  return (
    <figure className={cn("m-0", className)}>
      <ol className={cn("list-none p-0 m-0", size === "sm" ? "flex items-end gap-1" : "grid grid-cols-4 justify-items-start gap-x-2 gap-y-3 sm:flex sm:flex-wrap sm:items-end sm:gap-3")} aria-label={caption ?? t("c.cycles", { every: card.every })}>
        {card.stamps.map((s, i) => (
          <li key={`${s.date}-${i}`} className="flex flex-col items-center gap-1" title={size === "sm" ? stampLabel(s, currency, t) : undefined}>
            <span className="sr-only">{stampLabel(s, currency, t)}</span>
            <StampMark kind={s.kind} next={s.next} size={px} animate={animate} delay={i * 90} />
            {showDates && (
              <span aria-hidden="true" className={cn("num text-[0.6875rem] leading-none", s.next ? "font-semibold text-stamp" : "text-ink-2")}>
                {s.next ? t("c.next") : fmtDate(s.date).replace(/,.*/, "")}
              </span>
            )}
          </li>
        ))}
        {card.end && (
          <li className="flex flex-col items-center gap-1">
            <span className="sr-only">{card.end.kind === "cancelled" ? `${t("c.cancelled")}${card.end.date ? `, ${fmtDate(card.end.date, { year: true })}` : ""}` : t("c.pending")}</span>
            <span
              aria-hidden="true"
              className={cn("grid place-items-center rounded-[3px] font-mono font-semibold uppercase tracking-wide", card.end.kind === "cancelled" ? "bg-ink text-paper" : "border-2 border-dashed border-ink text-ink")}
              style={{ height: px, minWidth: px * 1.6, fontSize: Math.max(8, px / 3.6), padding: "0 4px" }}
            >
              {size === "sm" ? t("c.end") : card.end.kind === "cancelled" ? t("c.endedTag") : t("c.endingTag")}
            </span>
            {showDates && <span aria-hidden="true" className="num text-[0.6875rem] leading-none text-ink-2">{card.end.date ? fmtDate(card.end.date).replace(/,.*/, "") : ""}</span>}
          </li>
        )}
      </ol>
      {caption && size !== "sm" && <figcaption className="mt-2 text-sm text-ink-2">{caption}</figcaption>}
    </figure>
  );
}

export function StampLegend({ className }: { className?: string }) {
  const { t } = useT();
  const items: [StampKind, string, boolean?][] = [
    ["paid", t("c.paid")],
    ["discount", t("c.lDiscounted")],
    ["skipped", t("c.skipped")],
    ["paused", t("c.paused")],
    ["failed", t("c.lFailed")],
    ["upcoming", t("c.lNext"), true],
  ];
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-2 p-0 m-0 list-none text-sm text-ink-2", className)} aria-label={t("c.legend")}>
      {items.map(([k, l, next]) => (
        <li key={k} className="flex items-center gap-1.5">
          <StampMark kind={k} next={next} size={16} />
          {l}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block h-4 w-6 rounded-[2px] bg-ink" />
        {t("c.lEnded")}
      </li>
    </ul>
  );
}
