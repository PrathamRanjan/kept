/**
 * Screenshots for docs/screenshots: every main screen at 375, 768 and 1440 px, light and dark.
 * Usage: node scripts/shots.mjs [base=http://localhost:4112] [memberBase=base]
 * memberBase can point at the e2e server (npm run e2e's server) for a live, actionable member page.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const base = process.argv[2] || "http://localhost:4112";
const memberBase = process.argv[3] || base;
const out = "docs/screenshots";
mkdirSync(out, { recursive: true });
let ref = (await (await fetch(memberBase + "/ui/session")).json()).demoMemberRef;
if (memberBase.includes("4199")) {
  ref = (await (await fetch(memberBase + "/__e2e/member", { method: "POST" })).json()).ref;
  await fetch(`${memberBase}/ui/manage/${ref}/skip`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
}
const pages = [
  ["landing", base, "/"],
  ["demo", base, "/demo"],
  ["shop", base, "/s/ember-oak-coffee-club"],
  ["member", memberBase, `/manage/${ref}`],
  ["owner-today", base, "/dashboard"],
  ["owner-members", base, "/dashboard/members"],
  ["owner-approvals", base, "/dashboard/approvals"],
  ["tool-compliance", base, "/dashboard/compliance"],
];
const sizes = [[375, 812], [768, 1024], [1440, 900]];
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const [w, h] of sizes) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w === 1440 ? 1 : 2 });
    await ctx.addInitScript(() => {
      ["owner", "member", "shop"].forEach((t) => localStorage.setItem(`kept-tour-seen-${t}`, "never"));
      localStorage.setItem("kept-ribbon", "shown");
    });
    const p = await ctx.newPage();
    // Cookies on localhost are shared across ports, so sign in as the owner on the main server only.
    await p.goto(base + "/demo");
    await p.request.post(base + "/ui/demo/owner");
    for (const [name, origin, path] of pages) {
      await p.goto(origin + path, { waitUntil: "networkidle" });
      for (let y = 0; y < 4000; y += 700) await p.evaluate((y) => scrollTo(0, y), y), await p.waitForTimeout(80);
      await p.evaluate(() => scrollTo(0, 0));
      await p.waitForTimeout(name === "owner-members" || name === "owner-today" ? 1800 : 500);
      await p.screenshot({ path: `${out}/${name}-${w}-${scheme}.png`, fullPage: w === 1440 && scheme === "light" && name === "landing" });
    }
    await ctx.close();
  }
}
await b.close();
console.log("saved", pages.length * sizes.length * 2, "screenshots to", out);
