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
}

export function layout(o: LayoutOpts, body: Raw): string {
  const nav = o.owner
    ? html`<a href="/dashboard" class="${o.nav === "dashboard" ? "active" : ""}">Dashboard</a><a href="/s/${o.owner.slug}">Shop page</a><a href="/onboard/rules">Rules</a><a href="/dashboard/guard">Guard</a><a href="/dashboard/money">Money</a><a href="/dashboard/eval">Evals</a><a href="/dashboard/traces">Runs</a><a href="/dashboard/channels">Channels</a><a href="/dashboard/evidence">Evidence</a><a href="/agents" class="${o.nav === "agents" ? "active" : ""}">For agents</a><form method="post" action="/logout" class="inline"><button class="btn small" type="submit">Sign out</button></form>`
    : html`<a href="/agents" class="${o.nav === "agents" ? "active" : ""}">For agents</a><a href="/onboard" class="${o.nav === "onboard" ? "active" : ""}">Set up a shop</a><a href="/login" class="${o.nav === "login" ? "active" : ""}">Owner sign-in</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description ?? "Kept: PayPal subscriptions that AI agents can manage, with fair retention for small shops.")}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231f5c47'/%3E%3Ctext x='16' y='22' font-size='17' text-anchor='middle' fill='white' font-family='Arial' font-weight='700'%3EK%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/app.css">
${o.head ? o.head.value : ""}
</head>
<body>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1f5c47">
<header class="topbar"><div class="wrap"><a class="brand" href="/"><span class="dot">K</span>Kept</a>${o.owner ? html`<span class="muted">· ${o.owner.name}</span>`.value : ""}<nav class="nav">${nav.value}</nav></div></header>
<main><div class="wrap">${body.value}</div></main>
<footer><div class="wrap">Kept runs on the PayPal sandbox. No real money moves. Rows marked <span class="pill sample">sample</span> are labelled demo data.</div></footer>
${o.scripts ? o.scripts.value : ""}
</body>
</html>`;
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
