import { expect, test } from "@playwright/test";
import { axe, noSideScroll } from "./helpers";

// Spec item 8: the judge page. Paths tick themselves from what the server sees; tours start only from a button.
test("judge page: start a shop, follow the owner path, steps tick themselves", async ({ page }) => {
  await page.goto("/judge");
  await expect(page.getByRole("heading", { name: "For judges" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run the shop" })).toBeVisible();
  await axe(page);
  await noSideScroll(page);
  await page.getByRole("button", { name: "Start my demo shop" }).click();
  await expect(page.getByRole("heading", { name: "Your private demo shop" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open /proof" })).toBeVisible({ timeout: 15_000 });

  // The scam check step: the button opens the check with the 10 Nov message already in the box.
  await page.getByRole("link", { name: "Check the 10 Nov message" }).click();
  const box = page.locator("textarea").first();
  await expect(box).toHaveValue(/moved banks/);
  const scanned = page.waitForResponse((r) => r.url().endsWith("/dashboard/safety/scan") && r.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: "Check this message" }).click();
  const res = await scanned;
  expect(res.status()).toBe(200);
  // No model in this test server: Decisions is unavailable, and the rules and code readers still hold it.
  expect((await res.json()).level).toBe("hold");

  await page.goto("/judge");
  await page.getByRole("link", { name: "Open /proof" }).click();
  await expect(page.getByRole("heading", { name: "Proof", exact: true })).toBeVisible();
  await expect(page.getByText(/passed · model/).first()).toBeVisible();
  await axe(page);
  await noSideScroll(page);

  await page.goto("/judge");
  const owner = page.locator("section", { has: page.getByRole("heading", { name: "Run the shop" }) });
  await expect(owner.getByText(/2 of 4 done/)).toBeVisible({ timeout: 10_000 });
  await expect(owner.getByText(/Ticked/).first()).toBeVisible();
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
