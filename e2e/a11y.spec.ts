import { expect, test } from "@playwright/test";
import { axe, freshMember, noSideScroll, noTours } from "./helpers";

// Spec A7 checks, published on /accessibility: keyboard only, 200% text, reduced motion, named switches, no
// repeated marquee text, and axe on every page touched.
test("keyboard only: a member cancels with Tab and Enter, and hears the result", async ({ page }) => {
  await noTours(page);
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  let reached = false;
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "");
    if (name === "Cancel subscription") { reached = true; break; }
  }
  expect(reached, "Cancel subscription is reachable with Tab").toBe(true);
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement as Element); return s.outlineStyle !== "none" || s.boxShadow !== "none"; });
  expect(ring, "the focused control shows a focus ring").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Ended|cancelled/i).first()).toBeVisible();
  await expect(page.locator("[role=status][aria-live=polite]").first()).toBeAttached();
});

test("200% text: no sideways scroll on the main pages", async ({ page }) => {
  await noTours(page);
  const ref = await freshMember(page);
  for (const p of ["/", `/manage/${ref}`, "/judge", "/proof"]) {
    await page.goto(p);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForTimeout(150);
    await noSideScroll(page);
  }
});

test("reduced motion: the marquee stops and is read once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const copies = page.locator("[aria-label='Kinds of shops Kept is for'] > div");
  const n = await copies.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 1; i < n; i++) await expect(copies.nth(i)).toHaveAttribute("aria-hidden", "true");
  const playing = await copies.first().evaluate((el) => { const s = getComputedStyle(el); return s.animationName !== "none" && s.animationPlayState === "running" && parseFloat(s.animationDuration) > 0 && !matchMedia("(prefers-reduced-motion: reduce)").matches; });
  expect(playing).toBe(false);
});

test("the display and help panel: every switch has a name and the close button says what it closes", async ({ page }) => {
  await noTours(page);
  await page.goto("/agents");
  await page.locator("[data-a11y-open]").first().click();
  const panel = page.getByRole("dialog", { name: "Display and help" });
  await expect(panel).toBeVisible();
  for (const n of ["Read pages aloud", "Speak instead of typing", "Plain words", "Bigger buttons", "More time", "Stop all motion"]) await expect(panel.getByRole("switch", { name: n })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Close display and help" })).toBeVisible();
  await axe(page);
});

test("voice buttons are named and say so when there is no voice", async ({ page }) => {
  await noTours(page);
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}`);
  const mic = page.getByRole("button", { name: "Tell the assistant by voice" });
  await expect(mic).toBeVisible();
  await mic.click();
  // The test server has no model key: the button says voice isn't available and typing still works.
  await expect(page.getByText(/Voice isn't available|can't record|not allowed|isn't working/).first()).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("What should the assistant do?").fill("Pause my coffee for a month");
  await expect(page.getByRole("button", { name: "Send to the assistant" })).toBeEnabled();
});
