import { chromium } from "@playwright/test";
const out = process.argv[2]; const base = "http://localhost:4112";
const b = await chromium.launch();
const s = await (await fetch(base + "/ui/session")).json();
const routes = ["/", "/demo", "/s/ember-oak-coffee-club", `/manage/${s.demoMemberRef}`, "/dashboard", "/dashboard/members", "/dashboard/approvals", "/nope"]; const only = process.env.ONLY ? process.env.ONLY.split(",") : null; const rs = only ? routes.filter(r => only.some(o => r.startsWith(o))) : routes;
for (const scheme of (process.env.SCHEMES || "light,dark").split(",")) {
  const ctx = await b.newContext({ viewport: { width: 375, height: 800 }, colorScheme: scheme });
  await ctx.addInitScript(() => ["owner","member","shop"].forEach((t) => localStorage.setItem("kept-tour-seen-" + t, "never")));
  const p = await ctx.newPage();
  const errs = [];
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
  await p.goto(base + "/demo"); await p.request.post(base + "/ui/demo/owner");
  for (const r of rs) {
    await p.goto(base + r, { waitUntil: "networkidle" });
    await p.waitForTimeout(600);
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, h1: document.querySelector("h1")?.textContent, small: [...document.querySelectorAll("a,button,input,select,[role=button]")].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24) && getComputedStyle(e).visibility !== "hidden"; }).map(e => (e.textContent || e.getAttribute("aria-label") || e.tagName).trim().slice(0, 30)).slice(0, 8) }));
    console.log(scheme, r, JSON.stringify(m));
    await p.screenshot({ path: `${out}/${scheme}${r.replace(/\//g, "_") || "_root"}.png`, fullPage: true });
  }
  console.log(scheme, "errors:", JSON.stringify(errs.slice(0, 10)));
  await ctx.close();
}
await b.close();
