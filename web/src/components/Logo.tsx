import { Link } from "react-router-dom";

/** The wordmark: a filled stamp, then "Kept". */
export function Logo({ to = "/", sub }: { to?: string; sub?: string }) {
  return (
    <Link to={to} className="inline-flex min-h-11 items-center gap-2 rounded-md text-ink no-underline" aria-label="Kept, home">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <circle cx="13" cy="13" r="11" fill="var(--stamp)" />
        <path d="M8.2 13.4l3.1 3.1 6.4-7" stroke="var(--card-stock)" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="font-display text-[1.375rem] font-bold tracking-tight">Kept</span>
      {sub && <span className="hidden border-l border-rule pl-2 text-sm text-ink-2 sm:inline">{sub}</span>}
    </Link>
  );
}
