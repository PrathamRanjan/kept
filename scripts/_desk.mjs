import { chromium } from "@playwright/test";
const out = process.argv[2]; const base = "http://localhost:4112";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => ["owner","member","shop"].forEach((t) => localStorage.setItem("kept-tour-seen-" + t, "never")));
const p = await ctx.newPage(); const errs = [];
p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0,150)));
p.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
p.on("response", (r) => r.status() >= 400 && errs.push("HTTP " + r.status() + " " + r.url()));
await p.goto(base + "/demo"); await p.request.post(base + "/ui/demo/owner");
for (const r of ["/", "/dashboard", "/dashboard/members", "/dashboard/approvals"]) {
  await p.goto(base + r, { waitUntil: "networkidle" });
  for (let y = 0; y < 8000; y += 600) { await p.evaluate((y) => scrollTo(0, y), y); await p.waitForTimeout(150); }
  await p.waitForTimeout(2500); await p.evaluate(() => scrollTo(0, 0));
  await p.screenshot({ path: `${out}/desk${r.replace(/\//g, "_")}.png`, fullPage: true });
  console.log(r, await p.evaluate(() => ({ cal: !!document.querySelector(".b-calendar"), grid: !!document.querySelector(".ag-root"), rows: document.querySelectorAll(".ag-row").length })));
}
console.log(JSON.stringify(errs, null, 1));
await b.close();
