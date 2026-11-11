import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Spec A12: the robot judge. It does what the /judge page asks, on production, and records each step with how long
// it took. Paths that need a real PayPal subscription (pause, resume, cancel) are not run, because each run would
// use up one of the pre-approved sandbox subscriptions only the owner can make; the file says so for each.
type Step = { path: string; step: string; ok: boolean; seconds: number; saw: string };
const steps: Step[] = [];
const started = Date.now();
const base = process.env.ROBOT_BASE || "https://pph-kept.onrender.com";

async function run(path: string, step: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const saw = await fn();
    steps.push({ path, step, ok: true, seconds: Math.round((Date.now() - t0) / 100) / 10, saw });
  } catch (e) {
    steps.push({ path, step, ok: false, seconds: Math.round((Date.now() - t0) / 100) / 10, saw: (e as Error).message.split("\n")[0].slice(0, 240) });
  }
}
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude(".b-calendar").exclude(".ag-root-wrapper").analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (bad.length) throw new Error(`axe: ${bad.map((v) => v.id).join(", ")}`);
  return r.passes.length;
}
async function sideways(page: Page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  if (sw > w) throw new Error(`scrolls sideways at ${w}px (${sw}px wide)`);
}

test.afterAll(() => {
  const passed = steps.filter((s) => s.ok).length;
  const perPath: Record<string, number> = {};
  for (const s of steps) perPath[s.path] = Math.round(((perPath[s.path] ?? 0) + s.seconds) * 10) / 10;
  mkdirSync("eval", { recursive: true });
  writeFileSync("eval/robot-judge.json", JSON.stringify({
    suite: "robot-judge",
    title: "Robot judge: the /judge paths, followed by a browser on the live site",
    about: `A Playwright browser opened ${base}, started a demo shop with no real PayPal subscriptions, and did what each /judge step says. Seconds per path: ${Object.entries(perPath).map(([k, v]) => `${k} ${v} s`).join(", ")}. Total ${Math.round((Date.now() - started) / 1000)} s.`,
    model: null,
    runner: process.env.GITHUB_ACTIONS ? "GitHub Actions, robot-judge workflow" : "Playwright, run by hand",
    run_at: new Date().toISOString(),
    base,
    seconds_per_path: perPath,
    cases: steps.map((s, i) => ({ id: `r${String(i + 1).padStart(2, "0")}`, input: `${s.path}: ${s.step}`, expected: "works", actual: `${s.saw} (${s.seconds} s)`, pass: s.ok })),
    not_measured: [
      "Pause, resume and cancel on a real PayPal subscription: each run would use up one of the owner's pre-approved sandbox subscriptions. Checked by hand on the live site instead (README, item 8 and 11 logs).",
      "Approving a subscription on PayPal's own page: the robot never signs in to PayPal.",
      "A screen reader and a real microphone: axe and keyboard checks are not a substitute.",
    ],
  }, null, 1));
  console.log(`robot judge: ${passed} of ${steps.length} steps passed`);
});

test("robot judge follows the /judge paths on the live site", async ({ page }) => {
  await page.addInitScript(() => ["owner", "member", "shop"].forEach((t) => localStorage.setItem(`kept-tour-seen-${t}`, "never")));

  for (const [p, h] of [["/", null], ["/judge", "For judges"], ["/proof", "Proof"], ["/ai", "What the AI did"], ["/paypal", "PayPal in Kept"], ["/who-can-move-money", "Who can move money"], ["/accessibility", "Accessibility"], ["/agents", null]] as const) {
    await run("public", `open ${p}, axe, no sideways scroll at 1440px and at 200% text`, async () => {
      const r = await page.goto(p);
      if (!r || r.status() !== 200) throw new Error(`HTTP ${r?.status()}`);
      if (h) await expect(page.getByRole("heading", { name: h, exact: true }).first()).toBeVisible({ timeout: 20_000 });
      const passes = await axe(page);
      await sideways(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await sideways(page);
      return `HTTP 200, axe clean (${passes} rules passed)`;
    });
  }

  await run("start", "start a demo shop (no pool subscriptions)", async () => {
    const r = await page.request.post("/demo/start", { data: { pool: false }, headers: { accept: "application/json" } });
    if (r.status() !== 200) throw new Error(`HTTP ${r.status()}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    await page.goto("/judge");
    await expect(page.getByRole("heading", { name: "Your private demo shop" })).toBeVisible({ timeout: 20_000 });
    return `workspace ${j.workspace.id}, ${j.counts.samples} sample members, pool ${j.pool.state}`;
  });

  const owner = async (label: string) => {
    await page.goto("/judge");
    const link = page.getByRole("link", { name: label });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
  };
  await run("owner", "Ask the AI why people are cancelling", async () => {
    await owner("Ask: Why are people cancelling?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByText(/Answered by|The AI stopped|couldn't answer/i).first()).toBeVisible({ timeout: 150_000 });
    const answered = await page.getByText(/Answered by/).first().textContent().catch(() => null);
    if (!answered) throw new Error("no answer: the Ask stopped");
    return answered.replace(/\s+/g, " ").slice(0, 120);
  });
  await run("owner", "Write a rule the law forbids; it is refused with the citation", async () => {
    await owner("Try: three retention offers before cancel");
    await expect(page.getByText(/ROSCA|16 CFR|refused/i).first()).toBeVisible({ timeout: 90_000 });
    return ((await page.getByText(/ROSCA|16 CFR/).first().textContent()) ?? "").replace(/\s+/g, " ").slice(0, 140);
  });
  await run("owner", "Check the 10 Nov scam message; it is held", async () => {
    await owner("Check the 10 Nov message");
    const res = page.waitForResponse((r) => r.url().endsWith("/dashboard/safety/scan") && r.request().method() === "POST", { timeout: 90_000 });
    await page.getByRole("button", { name: "Check this message" }).click();
    const j = await (await res).json();
    if (j.level !== "hold") throw new Error(`level ${j.level}`);
    return `hold; rules ${j.readers.rules.level}, code ${j.readers.code.level}, Decisions ${j.readers.decisions.level ?? j.readers.decisions.status}`;
  });
  await run("owner", "Open /proof", async () => {
    await owner("Open /proof");
    await expect(page.getByText(/passed · model/).first()).toBeVisible({ timeout: 20_000 });
    return `${await page.getByText(/passed · model/).count()} suites listed`;
  });
  await run("owner", "the judge page ticked all four owner steps by itself", async () => {
    await page.goto("/judge");
    const sec = page.locator("section", { has: page.getByRole("heading", { name: "Run the shop" }) });
    await expect(sec.getByText(/4 of 4 done/)).toBeVisible({ timeout: 20_000 });
    return "4 of 4 done";
  });

  await run("assistant", "open the member page and ask the assistant what's next (sample member: read only)", async () => {
    await page.goto("/judge");
    await expect(page.getByRole("heading", { name: "Be the member's assistant" })).toBeVisible({ timeout: 20_000 });
    const link = page.getByRole("link", { name: "Ask: What's my next payment?" }).first();
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    await page.getByRole("button", { name: "Send to the assistant" }).click();
    await expect(page.getByText(/^Your assistant$|The assistant stopped/).first()).toBeVisible({ timeout: 150_000 });
    if (await page.getByText("The assistant stopped").count()) throw new Error(((await page.getByRole("alert").first().textContent()) ?? "stopped").slice(0, 160));
    const by = (await page.getByText(/^By .* in [\d.]+ s/).first().textContent()) ?? "";
    return `answered; ${by.replace(/\s+/g, " ").slice(0, 100)}`;
  });

  expect(steps.filter((s) => !s.ok).map((s) => `${s.path}: ${s.step}: ${s.saw}`)).toEqual([]);
});
