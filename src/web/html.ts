import { renderShell, type Brand, type NavGroup, type ShellPage } from "./shell.js";
/** Minimal safe HTML templating: every interpolated value is escaped unless wrapped in raw(). */
export class Raw {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (s: string) => new Raw(s);

export function esc(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(esc).join("");
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += esc(values[i]) + strings[i + 1];
  return new Raw(out);
}

export interface LayoutOpts {
  title: string;
  nav?: "home" | "dashboard" | "agents" | "shop" | "manage" | "onboard" | "login";
  owner?: { name: string; slug: string } | null;
  head?: Raw;
  scripts?: Raw;
  description?: string;
  /** Customer pages: the shop's name in the header. */
  business?: string;
  wide?: boolean;
  /** Customer pages in another language: the shell's words and the trust line. Absent means English, as before. */
  words?: ShellPage["words"];
  trust?: string;
}

export const BRAND: Brand = {
  name: "Kept",
  mark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg>`,
  description: "Kept: PayPal subscriptions that customers and their AI agents can skip, pause or cancel in one step, with one fair offer within the shop's rules.",
  themeColor: "#2443c4",
  fonts: "family=Schibsted+Grotesk:wght@500;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500",
  layout: "topbar",
  testMode: "Test mode: subscriptions run on the PayPal sandbox, so no real money moves.",
  siteLinks: [["/#how", "How it works"], ["/#fair", "Fair by design"], ["/agents", "For AI agents"], ["/#try", "Sign in"]],
  cta: ["/#try", "Sign in"],
  siteFoot: "© 2026 Kept. Test mode: subscriptions run on the PayPal sandbox.",
  siteFootLinks: [["/judge", "Guided tour"], ["/onboard", "Set up a shop"], ["/login", "Owner sign-in"]],
  staticBase: "/static",
  legacyCss: ["legacy.css"],
};

const navFor = (slug: string): NavGroup[] => [
  { label: "Your shop", items: [["/dashboard", "Today", "home"], ["/dashboard/guard", "Approvals and limits", "shieldCheck"], ["/dashboard/money", "Money", "wallet"], [`/s/${slug}`, "Shop page", "store"]] },
  { label: "Settings", items: [["/onboard/rules", "Retention rules", "settings"], ["/dashboard/safety", "Scam protection", "shield"], ["/dashboard/channels", "Messages", "message"]] },
  { label: "Admin", admin: true, items: [["/dashboard/traces", "Runs", "layers"], ["/dashboard/eval", "Test results", "flask"], ["/dashboard/compliance", "Compliance", "receipt"], ["/dashboard/evidence", "Evidence", "gauge"], ["/agents", "For AI agents", "sparkles"]] },
];

export function layout(o: LayoutOpts, body: Raw): string {
  const common = { title: o.title.replace(/ · Kept( dashboard)?$/, ""), body: body.value, head: `<link rel="manifest" href="/manifest.webmanifest">${o.head?.value ?? ""}`, scripts: o.scripts?.value, wide: o.wide };
  if (o.nav === "manage" || (o.nav === "shop" && o.business)) {
    return renderShell(BRAND, { ...common, mode: "customer", business: o.business ?? "Your subscription", trust: o.trust ?? `${o.business ?? "This shop"} bills only through PayPal. A failed payment is only ever shown on this page; we never send a "pay here" link by text or email, or ask for a card number or a code.`, words: o.words });
  }
  if (o.owner && o.nav !== "home") {
    return renderShell(BRAND, { ...common, mode: "app", nav: navFor(o.owner.slug), homeHref: "/dashboard", workspace: o.owner.name, user: { name: "Shop owner", sub: o.owner.name, logout: "/logout", settings: "/dashboard/channels#phone" } });
  }
  return renderShell(BRAND, { ...common, mode: o.nav === "home" ? "site" : "plain" });
}

export function fmtMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function fmtDate(d: Date | string | null | undefined, withTime = false): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toLocaleString("en-US", withTime ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) + (withTime ? " UTC" : "");
}
