import { expect, test } from "@playwright/test";

test("Judge Mode walks all six pages from ?tour=judge and can be finished", async ({ page }) => {
  await page.request.post("/__e2e/member");
  await page.goto("/?tour=judge");
  const pop = page.locator(".driver-popover");
  const seen: string[] = [];
  for (let i = 0; i < 30; i++) {
    await expect(pop).toBeVisible({ timeout: 15_000 });
    const title = (await page.locator(".driver-popover-title").textContent())?.trim() ?? "";
    if (!seen.includes(title)) seen.push(title);
    if (title === "That's Kept") break;
    await page.locator(".driver-popover-next-btn").click();
    await page.waitForTimeout(250);
  }
  for (const n of [1, 2, 3, 4, 5, 6]) expect(seen.join("\n")).toContain(`${n} of 6`);
  expect(page.url()).toMatch(/\/dashboard\/members$/);
  await page.locator(".driver-popover-next-btn").click();
  await expect(pop).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("kept-tour"))).toBeNull();
});

test("Take the tour button restarts Judge Mode from the demo page", async ({ page }) => {
  await page.goto("/judge");
  await page.getByRole("button", { name: "Start Judge Mode" }).click();
  await expect(page.locator(".driver-popover-title")).toContainText("1 of 6");
});
