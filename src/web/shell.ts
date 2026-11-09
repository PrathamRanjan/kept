/**
 * The page shell every app renders through (hand-copied into each app as src/web/shell.ts; no cross-folder imports).
 * Four modes: "app" (signed-in sidebar shell), "customer" (a business's page for its customer, with a trust line),
 * "site" (the public landing page) and "plain" (a public page with the site header).
 * The app supplies its brand, navigation and words; this file owns the structure so all eight stay consistent.
 */
import { icon } from "./icons.js";

const e = (v: unknown) => (v === null || v === undefined || v === false ? "" : String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!));

/** Changes on every deploy so browsers never keep a stale stylesheet. */
export const ASSET_V = (process.env.RENDER_GIT_COMMIT || Date.now().toString(36)).slice(0, 8);

export interface Brand {
  name: string;
  /** Inline SVG for the brand mark (stroke uses currentColor). */
  mark: string;
  description: string;
  themeColor: string;
  /** Google Fonts css2 query, e.g. "family=Geist:wght@400;600&family=Geist+Mono". Atkinson Hyperlegible is added for the dyslexia-friendly option. */
  fonts: string;
  /** Short line in the signed-in footer. */
  appFoot: string;
  /** Public header links. */
  siteLinks: [href: string, label: string][];
  cta: [href: string, label: string];
  /** Public footer left text and right links. */
  siteFoot: string;
  siteFootLinks: [href: string, label: string][];
  /** Static path prefix ("/static" or "" etc). */
  staticBase: string;
  /** Extra stylesheet paths under staticBase loaded before ui.css (the app's legacy app.css). */
  legacyCss?: string[];
}

export type NavItem = [href: string, label: string, ic: string];
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface ShellPage {
  mode: "app" | "customer" | "site" | "plain";
  title: string;
  body: string;
  flash?: { ok?: string; err?: string } | null;
  head?: string;
  scripts?: string;
  /** app mode */
  nav?: NavGroup[];
  user?: { name: string; sub: string; settings?: string; logout?: string } | null;
  homeHref?: string;
  workspace?: string;
  /** Extra header content in app mode (an ask bar); defaults to a spacer. */
  top?: string;
  /** customer mode */
  business?: string;
  trust?: string;
  wide?: boolean;
}

const tools = () =>
  `<div class="tools"><button class="iconbtn" type="button" data-a11y-read aria-pressed="false" title="Read this page aloud" aria-label="Read this page aloud">${icon("volume")}</button><button class="btn small" type="button" data-a11y-open aria-haspopup="dialog">${icon("type")}<span>Display</span></button></div>`;

function head(b: Brand, title: string, extra = ""): string {
  const s = b.staticBase;
  const css = [...(b.legacyCss ?? []), "ui.css", "theme.css", "a11y.css"].map((f) => `<link rel="stylesheet" href="${s}/${f}?v=${ASSET_V}">`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(b.description)}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${b.themeColor}'/><g transform='translate(4 4)' color='white'>${b.mark.replace(/<svg[^>]*>/, "").replace("</svg>", "")}</g></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${b.fonts}&family=Atkinson+Hyperlegible:wght@400;700&display=swap">
${css}
<meta name="theme-color" content="${e(b.themeColor)}">
${extra}
</head>`;
}

function flashOf(f?: { ok?: string; err?: string } | null) {
  return f?.ok ? `<div class="banner good" role="status">${e(f.ok)}</div>` : f?.err ? `<div class="banner bad" role="alert">${e(f.err)}</div>` : "";
}

function sidebar(b: Brand, p: ShellPage): string {
  const groups = (p.nav ?? [])
    .filter((g) => g.items.length)
    .map((g) => `<div class="sb-label">${e(g.label)}</div><nav class="sb-nav" aria-label="${e(g.label)}">${g.items.map(([href, label, ic]) => `<a href="${e(href)}">${icon(ic)}<span>${e(label)}</span></a>`).join("")}</nav>`)
    .join("");
  const u = p.user;
  const initials = u ? u.name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() : "";
  const foot = u
    ? `<div class="sb-foot"><div class="sb-user"><span class="avatar">${e(initials)}</span><span><b>${e(u.name)}</b><span>${e(u.sub)}</span></span></div><div class="row">${u.settings ? `<a class="btn small ghost" href="${e(u.settings)}">${icon("settings")}Settings</a>` : ""}${u.logout ? `<form method="post" action="${e(u.logout)}" class="inline"><button class="btn small ghost" type="submit">${icon("logout")}Sign out</button></form>` : ""}</div></div>`
    : "";
  return `<aside class="sidebar"><a class="sb-brand" href="${e(p.homeHref ?? "/")}"><span class="mark">${b.mark}</span><span>${e(b.name)}${p.workspace ? `<small>${e(p.workspace)}</small>` : ""}</span></a>${groups}${foot}</aside>`;
}

export function renderShell(b: Brand, p: ShellPage): string {
  const flash = flashOf(p.flash);
  const tail = `${p.scripts ?? ""}<script src="${b.staticBase}/a11y.js?v=${ASSET_V}" defer></script></body></html>`;
  if (p.mode === "app") {
    return `${head(b, `${p.title} · ${b.name}`, p.head)}
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">${sidebar(b, p)}
<div class="maincol">
<header class="topline"><details class="mnav"><summary class="iconbtn" aria-label="Menu">${icon("menu")}</summary>${sidebar(b, p)}</details><span class="crumb">${e(p.title)}</span>${p.top ?? `<div class="grow"></div>`}${tools()}</header>
<main id="main" class="content">${flash}${p.body}</main>
<footer class="site-foot">${e(b.appFoot)}</footer>
</div></div>
${tail}`;
  }
  if (p.mode === "customer") {
    const biz = p.business ?? b.name;
    return `${head(b, `${p.title} · ${biz}`, p.head)}
<body class="customer">
<a class="skip" href="#main">Skip to content</a>
<header class="site-nav"><div class="wrap"><span class="sb-brand plain"><span class="mark">${e(biz[0] ?? "")}</span>${e(biz)}</span><div class="links">${tools()}</div></div></header>
<main id="main" class="content narrow${p.wide ? " wide" : ""}">${flash}${p.body}
${p.trust ? `<p class="trust-line foot-trust">${icon("shieldCheck")}<span>${e(p.trust)}</span></p>` : ""}</main>
<footer class="lp-foot"><div class="wrap"><span>Payments are handled by PayPal. Powered by ${e(b.name)}.</span></div></footer>
${tail}`;
  }
  const links = b.siteLinks.map(([h, l]) => `<a href="${e(h)}">${e(l)}</a>`).join("");
  return `${head(b, p.mode === "site" ? `${b.name}: ${p.title}` : `${p.title} · ${b.name}`, p.head)}
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-nav"><div class="wrap"><a class="sb-brand plain" href="/"><span class="mark">${b.mark}</span>${e(b.name)}</a><div class="links">${links}${tools()}<a class="btn small primary" href="${e(b.cta[0])}">${e(b.cta[1])}</a></div></div></header>
<main id="main">${p.mode === "site" ? `${flash ? `<div class="wrap flash-wrap">${flash}</div>` : ""}${p.body}` : `<div class="content${p.wide ? " wide" : " narrow"}">${flash}${p.body}</div>`}</main>
<footer class="lp-foot"><div class="wrap spread"><span>${e(b.siteFoot)}</span><span>${b.siteFootLinks.map(([h, l]) => `<a href="${e(h)}">${e(l)}</a>`).join(" · ")}</span></div></footer>
${tail}`;
}
