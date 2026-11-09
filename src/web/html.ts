import { renderShell, type Brand, type NavGroup } from "./shell.js";
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
}

export const BRAND: Brand = {
  name: "Kept",
  mark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M7 2v2"/><path d="M11 2v2"/></svg>`,
  description: "Kept: PayPal subscriptions that customers and their AI agents can skip, pause or cancel in one step, with one fair offer within the shop's rules.",
  themeColor: "#3e2417",
  fonts: "family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500",
  appFoot: "PayPal sandbox: no real money moves. Cancelling always works in one step; rows marked sample are labelled demo data.",
  siteLinks: [["/#how", "How it works"], ["/#fair", "Fair by design"], ["/#try", "Try it"], ["/agents", "For AI agents"]],
  cta: ["/#try", "Try the demo"],
  siteFoot: "Kept · built for the PayPal AI Hackathon · PayPal sandbox only, no real money moves.",
  siteFootLinks: [["/judge", "Judge tour"], ["/onboard", "Set up a shop"], ["/login", "Owner sign-in"]],
  staticBase: "/static",
  legacyCss: ["legacy.css"],
};

const navFor = (slug: string): NavGroup[] => [
  { label: "Your shop", items: [["/dashboard", "Today", "home"], ["/dashboard/guard", "Approvals and limits", "shieldCheck"], ["/dashboard/money", "Money", "wallet"], [`/s/${slug}`, "Shop page", "store"]] },
  { label: "Settings", items: [["/onboard/rules", "Retention rules", "settings"], ["/dashboard/safety", "Scam protection", "shield"], ["/dashboard/channels", "Messages", "message"]] },
  { label: "How it works", items: [["/dashboard/traces", "Runs", "layers"], ["/dashboard/eval", "Test results", "flask"], ["/dashboard/compliance", "Compliance", "receipt"], ["/dashboard/evidence", "Evidence", "gauge"], ["/agents", "For AI agents", "sparkles"]] },
];

export function layout(o: LayoutOpts, body: Raw): string {
  const common = { title: o.title.replace(/ · Kept( dashboard)?$/, ""), body: body.value, head: `<link rel="manifest" href="/manifest.webmanifest">${o.head?.value ?? ""}`, scripts: o.scripts?.value, wide: o.wide };
  if (o.nav === "manage" || (o.nav === "shop" && o.business)) {
    return renderShell(BRAND, { ...common, mode: "customer", business: o.business ?? "Your subscription", trust: `${o.business ?? "This shop"} bills only through PayPal. A failed payment is only ever shown on this page; we never send a "pay here" link by text or email, or ask for a card number or a code.` });
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
