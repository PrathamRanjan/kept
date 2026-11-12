import { expect, test, type Page } from "@playwright/test";
import { noTours } from "./helpers";

/**
 * The guided walkthrough the persona buttons on /demo start (web/src/story.ts): a card that says who you are, then
 * steps across pages. Each step must show on its own page and highlight a real part of it, and it must end cleanly.
 */
const title = (page: Page) => page.locator(".driver-popover-title");
const next = (page: Page) => page.locator(".driver-popover-next-btn");
const lit = (page: Page, key: string) => expect(page.locator(`.driver-active-element[data-tour^="${key}"]`)).toHaveCount(1);
const saved = (page: Page) => page.evaluate(() => sessionStorage.getItem("kept-story"));

test.beforeEach(async ({ page }) => noTours(page));

test("story: landing → Try → the owner's walkthrough covers Today, Ask, members, a member's page and the shop", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Try the live demo/ }).first().click();
  await expect(page).toHaveURL(/\/demo$/);
  await page.getByRole("button", { name: "Start as the owner" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(title(page)).toHaveText(/^You are the owner of .+/);
  await next(page).click(); // "Start"
  await expect(title(page)).toHaveText("Your shop at a glance");
  await lit(page, "kpis");
  await next(page).click();
  await expect(title(page)).toHaveText("What needs you");
  await lit(page, "needs");
  await next(page).click();
  await expect(title(page)).toHaveText("Ask about your shop");
  await lit(page, "ask");
  // An "act" step: a click inside the highlighted part frees the page, and the corner button carries on.
  await page.locator("[data-tour='ask'] input").dispatchEvent("pointerdown");
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await expect(page.locator(".kept-story-pill")).toContainText("Step 4 of");
  await page.locator(".kept-story-next").click();

  await expect(page).toHaveURL(/\/dashboard\/members$/);
  await expect(title(page)).toHaveText("Every member");
  await lit(page, "grid");
  await next(page).click();

  await expect(page).toHaveURL(/\/manage\//);
  await expect(title(page)).toHaveText("Now you're one of your members");
  await lit(page, "card");
  // Change, the assistant and Cancel show only when this member can do them (a sample member can't); the walkthrough
  // skips what's missing, so each next card must be the next one this page has, in order, ending with the history.
  const rest = [["Skip, pause or switch", "change"], ["Or let your AI assistant do it", "assistant"], ["Cancel in one step", "cancel"], ["Who did what", "history"]] as const;
  for (let j = 0; j < rest.length; ) {
    await next(page).click();
    await expect(title(page)).toHaveText(new RegExp(`^(${rest.slice(j).map((r) => r[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`));
    const shown = (await title(page).textContent())!;
    const k = rest.findIndex((r) => r[0] === shown);
    expect(k).toBeGreaterThanOrEqual(j);
    expect(await page.locator(`[data-tour="${rest[k][1]}"]`).count(), `${shown} is shown only when its part exists`).toBeGreaterThan(0);
    await lit(page, rest[k][1]);
    j = k + 1;
  }
  await next(page).click();

  await expect(page).toHaveURL(/\/s\//);
  await expect(title(page)).toHaveText("A new member subscribes");
  await lit(page, "plans");
  await next(page).click();
  await expect(title(page)).toHaveText("The shop's promise");
  await lit(page, "promise");
  await next(page).click();
  await expect(title(page)).toHaveText(/^That's a day at .+/);
  await next(page).click(); // "Finish"
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  expect(await saved(page)).toBeNull();
});

test("story: the member's walkthrough opens with a role card, and leaving its page ends it", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start as a member" }).click();
  await expect(page).toHaveURL(/\/manage\//);
  await expect(title(page)).toHaveText(/^You are a member of .+/);
  await next(page).click();
  await expect(title(page)).toHaveText("Your subscription, stamp by stamp");
  await lit(page, "card");
  await page.goto("/judge"); // not one of the story's pages
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  expect(await saved(page)).toBeNull();
});

test("story: Skip the walkthrough opens the owner's Today with no popover", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Skip the walkthrough" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.waitForTimeout(800);
  await expect(page.locator(".driver-popover")).toHaveCount(0);
});
