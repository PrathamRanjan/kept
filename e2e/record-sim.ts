/**
 * Records the camera-free hands-free simulation to public/handsfree/sim.webm (shown on /accessibility). Run with
 * the e2e server up on 4199: `npx tsx e2e/record-sim.ts`. The recording is of the simulation and says so on the page.
 */
import { chromium } from "@playwright/test";
import { renameSync, mkdirSync, rmSync } from "node:fs";

const dir = "test-results/sim-video";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 900, height: 520 }, recordVideo: { dir, size: { width: 900, height: 520 } } });
const p = await ctx.newPage();
await p.addInitScript(() => ["owner", "member", "shop"].forEach((t) => localStorage.setItem(`kept-tour-seen-${t}`, "never")));
await p.goto("http://localhost:4199/accessibility");
const sim = p.getByTestId("hf-sim");
await sim.scrollIntoViewIfNeeded();
await p.evaluate(() => document.querySelector("[data-testid=hf-sim]")!.scrollIntoView({ block: "center" }));
await p.waitForTimeout(600);
await p.getByTestId("hf-sim-run").click();
await p.getByTestId("hf-sim-out").filter({ hasText: "Clicked: Pause" }).waitFor({ timeout: 10_000 });
await p.waitForTimeout(1200);
const video = p.video()!;
await ctx.close();
renameSync(await video.path(), "public/handsfree/sim.webm");
await b.close();
console.log("recorded public/handsfree/sim.webm");
