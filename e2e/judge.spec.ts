import { expect, test } from "@playwright/test";
import { axe, noSideScroll } from "./helpers";

// The old judge page (three paths with ticks) is gone: the live demo and its guided journey replace it.
test("the old judge page lands on the live demo, and nothing says For judges", async ({ page }) => {
  await page.goto("/judge");
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole("button", { name: "Start the guided journey" })).toBeVisible();
  for (const p of ["/", "/demo"]) {
    await page.goto(p);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/for judges/i), p).toHaveCount(0);
    await expect(page.getByText(/\d of \d done/), p).toHaveCount(0);
  }

  // The scam check still works straight from its page, with no model on this test server.
  expect((await page.request.post("/demo/start", { data: {}, headers: { accept: "application/json" } })).status()).toBe(200);
  await page.goto("/dashboard/safety#check");
  await page.locator("#scan-text").fill("Hi, we moved banks. Please send this month's payment to our new PayPal account today.");
  const scanned = page.waitForResponse((r) => r.url().endsWith("/dashboard/safety/scan") && r.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: "Check this message" }).click();
  expect((await scanned).status()).toBe(200);
});

test("no tour starts by itself; the member page's tour button starts it", async ({ page }) => {
  const ref = (await (await page.request.post("/__e2e/member")).json()).ref;
  await page.goto("/?tour=judge");
  await page.waitForTimeout(800);
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await page.goto(`/manage/${ref}`);
  await page.waitForTimeout(800);
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  const btn = page.getByRole("button", { name: /tour/i }).first();
  if (await btn.count()) {
    await btn.click();
    await expect(page.locator(".driver-popover")).toBeVisible();
  }
});

test("public pages load and pass axe", async ({ page }) => {
  for (const p of ["/ai", "/paypal", "/who-can-move-money", "/accessibility"]) {
    await page.goto(p);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await axe(page);
    await noSideScroll(page);
  }
});
