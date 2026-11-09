const CUR: Record<string, string> = { USD: "$", SGD: "S$", AUD: "A$", EUR: "€", GBP: "£" };

export function fmtMoney(v: number | string | null | undefined, currency = "USD"): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = typeof v === "string" ? Number(v) : v;
  return `${CUR[currency] ?? `${currency} `}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDate(v: string | Date | null | undefined, opts: { time?: boolean; year?: boolean } = {}): string {
  if (!v) return "–";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "–";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("en-US", { month: "short", day: "numeric", ...(opts.year || !sameYear ? { year: "numeric" } : {}), ...(opts.time ? { hour: "numeric", minute: "2-digit" } : {}) });
}

export function fmtRelative(v: string | Date | null | undefined): string {
  if (!v) return "";
  const ms = new Date(v).getTime() - Date.now();
  const abs = Math.abs(ms);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 3600_000) return rtf.format(Math.round(ms / 60_000), "minute");
  if (abs < 86400_000) return rtf.format(Math.round(ms / 3600_000), "hour");
  return rtf.format(Math.round(ms / 86400_000), "day");
}

export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
