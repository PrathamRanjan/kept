/**
 * The page shell every app renders through (hand-copied into each app as src/web/shell.ts; no cross-folder imports).
 * Four modes: "app" (signed-in shell), "customer" (a business's page for its customer, with a trust line),
 * "site" (the public landing page) and "plain" (a public page with the site header).
 * Four app layouts, picked per app in its Brand: "sidebar" (labelled side navigation), "rail" (a slim icon rail),
 * "topbar" (navigation across the top) and "dock" (top tabs on a computer, a bottom tab bar on a phone).
 * Every layout renders the same pieces; ui.css shows the ones the layout uses, so one page body fits all four.
 */
import { icon } from "./icons.js";

const e = (v: unknown) => (v === null || v === undefined || v === false ? "" : String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!));

/** Changes on every deploy so browsers never keep a stale stylesheet. */
export const ASSET_V = (process.env.RENDER_GIT_COMMIT || Date.now().toString(36)).slice(0, 8);

export type Layout = "sidebar" | "rail" | "topbar" | "dock";

export interface Brand {
  name: string;
  /** Inline SVG for the brand mark (stroke uses currentColor). */
  mark: string;
  description: string;
  themeColor: string;
  /** Google Fonts css2 query, e.g. "family=Geist:wght@400;600&family=Geist+Mono". Atkinson Hyperlegible is added for the dyslexia-friendly option. */
  fonts: string;
  /** Kept for older callers; no longer rendered (the header carries a Test mode chip instead of a footer line). */
  appFoot?: string;
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
  /** Signed-in layout; defaults to "sidebar". */
  layout?: Layout;
  /** What the Test mode chip says when opened, e.g. "PayPal sandbox: no real money moves." Omit to hide the chip. */
  testMode?: string;
}

export type NavItem = [href: string, label: string, ic: string];
export interface NavGroup {
  label: string;
  items: NavItem[];
  /** Operator and evaluation tools: kept out of the main navigation, listed under Admin. */
  admin?: boolean;
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
  /** Overrides the brand's layout for this page (e.g. a phone-first role in a desk-first app). */
  layout?: Layout;
  user?: { name: string; sub: string; settings?: string; logout?: string } | null;
  homeHref?: string;
  workspace?: string;
  /** Extra header content in app mode (an ask bar); defaults to a spacer. */
  top?: string;
  /** customer mode */
  business?: string;
  trust?: string;
  wide?: boolean;
  /** customer mode in another language: the page's lang and the shell's own words. Absent means English. */
  words?: { lang: string; skip: string; read: string; display: string; testChip: string; testMode: string; footer: string };
}

const tools = (w?: ShellPage["words"]) =>
  `<div class="tools"><button class="iconbtn" type="button" data-a11y-read aria-pressed="false" title="${e(w?.read ?? "Read this page aloud")}" aria-label="${e(w?.read ?? "Read this page aloud")}">${icon("volume")}</button><button class="btn small" type="button" data-a11y-open aria-haspopup="dialog">${icon("type")}<span>${e(w?.display ?? "Display")}</span></button></div>`;

const testChip = (b: Brand, w?: ShellPage["words"]) => {
  const note = w?.testMode ?? b.testMode;
  return b.testMode ? `<details class="testmode"><summary title="${e(note!)}">${icon("flask")}<span>${e(w?.testChip ?? "Test mode")}</span></summary><div class="menu tm-note">${e(note!)}</div></details>` : "";
};

function head(b: Brand, title: string, extra = "", lang = "en"): string {
  const s = b.staticBase;
  const css = [...(b.legacyCss ?? []), "ui.css", "theme.css", "a11y.css"].map((f) => `<link rel="stylesheet" href="${s}/${f}?v=${ASSET_V}">`).join("\n");
  return `<!doctype html>
<html lang="${e(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>try{var t=localStorage.getItem("kept-theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}</script>
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

const link = ([href, label, ic]: NavItem) => `<a href="${e(href)}" title="${e(label)}">${icon(ic)}<span>${e(label)}</span></a>`;
const initialsOf = (name: string) => name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();

function adminBlock(groups: NavGroup[], cls: string): string {
  const items = groups.flatMap((g) => g.items);
  if (!items.length) return "";
  return `<details class="${cls}"><summary title="Admin and test tools">${icon("wrench")}<span>Admin</span></summary><nav class="sb-nav" aria-label="Admin">${items.map(link).join("")}</nav></details>`;
}

function sidebar(b: Brand, p: ShellPage): string {
  const all = (p.nav ?? []).filter((g) => g.items.length);
  const groups = all
    .filter((g) => !g.admin)
    .map((g) => `<div class="sb-label">${e(g.label)}</div><nav class="sb-nav" aria-label="${e(g.label)}">${g.items.map(link).join("")}</nav>`)
    .join("");
  const u = p.user;
  const foot = u
    ? `<div class="sb-foot"><div class="sb-user" title="${e(u.name)}"><span class="avatar">${e(initialsOf(u.name))}</span><span class="who"><b>${e(u.name)}</b><span>${e(u.sub)}</span></span></div><div class="row">${u.settings ? `<a class="btn small ghost" href="${e(u.settings)}" title="Settings">${icon("settings")}<span>Settings</span></a>` : ""}${u.logout ? `<form method="post" action="${e(u.logout)}" class="inline"><button class="btn small ghost" type="submit" title="Sign out">${icon("logout")}<span>Sign out</span></button></form>` : ""}</div></div>`
    : "";
  return `<aside class="sidebar"><a class="sb-brand" href="${e(p.homeHref ?? "/")}" title="${e(b.name)}"><span class="mark">${b.mark}</span><span class="name">${e(b.name)}${p.workspace ? `<small>${e(p.workspace)}</small>` : ""}</span></a>${groups}${adminBlock(all.filter((g) => g.admin), "sb-admin")}${foot}</aside>`;
}

/** Top navigation for the topbar and dock layouts: the first six links inline, the rest under More. */
function topnav(p: ShellPage): string {
  const items = (p.nav ?? []).filter((g) => !g.admin).flatMap((g) => g.items);
  if (!items.length) return "";
  const shown = items.slice(0, 6), rest = items.slice(6);
  return `<nav class="topnav" aria-label="Main">${shown.map(link).join("")}${rest.length ? `<details class="tn-more"><summary>More</summary><div class="menu"><nav class="sb-nav" aria-label="More">${rest.map(link).join("")}</nav></div></details>` : ""}</nav>`;
}

/** Account menu for the topbar and dock layouts: who you are, settings, admin tools, sign out. */
function userMenu(p: ShellPage): string {
  const u = p.user;
  if (!u) return "";
  const admin = (p.nav ?? []).filter((g) => g.admin).flatMap((g) => g.items);
  return `<details class="umenu"><summary aria-label="Account: ${e(u.name)}"><span class="avatar">${e(initialsOf(u.name))}</span></summary><div class="menu"><div class="um-who"><b>${e(u.name)}</b><span>${e(u.sub)}</span></div>${u.settings ? `<nav class="sb-nav" aria-label="Account"><a href="${e(u.settings)}">${icon("settings")}<span>Settings</span></a></nav>` : ""}${admin.length ? `<div class="sb-label">Admin</div><nav class="sb-nav" aria-label="Admin">${admin.map(link).join("")}</nav>` : ""}${u.logout ? `<form method="post" action="${e(u.logout)}"><button class="btn small ghost um-out" type="submit">${icon("logout")}<span>Sign out</span></button></form>` : ""}</div></details>`;
}

/** Bottom tab bar on phones (dock layout): the first four links and a More button that opens the full menu. */
function dock(p: ShellPage): string {
  const items = (p.nav ?? []).filter((g) => !g.admin).flatMap((g) => g.items).slice(0, 4);
  if (!items.length) return "";
  return `<nav class="dock" aria-label="Main">${items.map(link).join("")}<button type="button" data-open-menu title="More">${icon("menu")}<span>More</span></button></nav>`;
}

export function renderShell(b: Brand, p: ShellPage): string {
  const flash = flashOf(p.flash);
  const L = p.layout ?? b.layout ?? "sidebar";
  const tail = `${p.scripts ?? ""}<script src="${b.staticBase}/a11y.js?v=${ASSET_V}" defer></script><script src="${b.staticBase}/journey.js?v=${ASSET_V}" defer></script></body></html>`;
  if (p.mode === "app") {
    return `${head(b, `${p.title} · ${b.name}`, p.head)}
<body class="L-${L}">
<a class="skip" href="#main">Skip to content</a>
<div class="shell">${sidebar(b, p)}
<div class="maincol">
<header class="topline"><details class="mnav"><summary class="iconbtn" aria-label="Menu">${icon("menu")}</summary>${sidebar(b, p)}</details><a class="tb-brand" href="${e(p.homeHref ?? "/")}"><span class="mark">${b.mark}</span><span class="name">${e(b.name)}${p.workspace ? `<small>${e(p.workspace)}</small>` : ""}</span></a>${topnav(p)}<span class="crumb">${e(p.title)}</span>${p.top ?? `<div class="grow"></div>`}${testChip(b)}${tools()}${userMenu(p)}</header>
<main id="main" class="content">${flash}${p.body}</main>
</div></div>
${L === "dock" ? dock(p) : ""}
${tail}`;
  }
  if (p.mode === "customer") {
    const biz = p.business ?? b.name;
    const w = p.words;
    return `${head(b, `${p.title} · ${biz}`, p.head, w?.lang)}
<body class="customer">
<a class="skip" href="#main">${e(w?.skip ?? "Skip to content")}</a>
<header class="site-nav"><div class="wrap"><span class="sb-brand plain"><span class="mark">${e(biz[0] ?? "")}</span>${e(biz)}</span><div class="links">${testChip(b, w)}${tools(w)}</div></div></header>
<main id="main" class="content narrow${p.wide ? " wide" : ""}">${flash}${p.body}
${p.trust ? `<p class="trust-line foot-trust">${icon("shieldCheck")}<span>${e(p.trust)}</span></p>` : ""}</main>
<footer class="lp-foot"><div class="wrap"><span>${w ? e(w.footer) : `Payments are handled by PayPal. Powered by ${e(b.name)}.`}</span></div></footer>
${tail}`;
  }
  const links = b.siteLinks.map(([h, l]) => `<a href="${e(h)}">${e(l)}</a>`).join("");
  return `${head(b, p.mode === "site" ? `${b.name}: ${p.title}` : `${p.title} · ${b.name}`, p.head)}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
<header class="site-nav"><div class="wrap"><a class="sb-brand plain" href="/"><span class="mark">${b.mark}</span>${e(b.name)}</a><div class="links">${links}${tools()}<a class="btn small primary" href="${e(b.cta[0])}">${e(b.cta[1])}</a></div></div></header>
<main id="main">${p.mode === "site" ? `${flash ? `<div class="wrap flash-wrap">${flash}</div>` : ""}${p.body}` : `<div class="content${p.wide ? " wide" : " narrow"}">${flash}${p.body}</div>`}</main>
<footer class="lp-foot"><div class="wrap spread"><span>${e(b.siteFoot)}</span><span>${b.siteFootLinks.map(([h, l]) => `<a href="${e(h)}">${e(l)}</a>`).join(" · ")}</span></div></footer>
${tail}`;
}
