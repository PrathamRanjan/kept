import { expect, test, type Page } from "@playwright/test";
import { axe, noSideScroll, noTours } from "./helpers";

// The guided journey (public/journey.js + src/demo/journey.ts): a corner card that never covers the page, follows one
// story across the owner, the member and the member's AI assistant, and keeps its place on the server.

const card = (page: Page) => page.locator("#kept-journey");
/** axe reads colours mid-fade otherwise; people see the card after its 0.25 s fade-in. */
const settled = (page: Page) => card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

test.beforeEach(async ({ page }) => noTours(page));

test("the demo page names the three people and starts the journey as the owner", async ({ page }) => {
  await page.goto("/demo");
  const who = page.getByRole("list", { name: "The three people in this demo" });
  await expect(who.getByText(/^1\. The owner$/)).toBeVisible();
  await expect(who.getByText(/^2\. The member$/)).toBeVisible();
  await expect(who.getByText(/^3\. The member's AI assistant$/)).toBeVisible();
  await noSideScroll(page);
  await page.getByRole("button", { name: "Start the guided journey" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-role", "owner");
  await expect(card(page)).toContainText("You are the owner of");
  await expect(card(page)).toContainText("Step 1 of");
  // The step's part of the page is outlined, not covered: the page under it still takes clicks and typing.
  await expect(page.locator("[data-tour='kpis'].kj-lit")).toBeVisible();
  await expect(page.locator(".driver-overlay")).toHaveCount(0);
  await page.locator("#q").fill("still typeable");
  await expect(page.locator("#q")).toHaveValue("still typeable");

  // Next, Next: the Ask step, where the guide can fill the question in.
  // Each step shows what it really uses as small tags, and ends with the judging criterion it answers.
  await expect(card(page).locator(".kj-tags")).toContainText("PayPal Subscriptions API");
  await expect(card(page).locator(".kj-crit")).toContainText("Technological implementation");
  await card(page).getByRole("button", { name: "Next" }).click();
  await expect(card(page)).toContainText("Step 2 of");
  // The held discount: the card outlines the approval itself (or the "needs you" list when none is waiting).
  await expect(page.locator("[data-tour='approval'].kj-lit, [data-tour='needs'].kj-lit").first()).toBeVisible();
  await card(page).getByRole("button", { name: "Next" }).click();
  await expect(card(page)).toContainText("Step 3 of");
  await card(page).getByRole("button", { name: "Fill it in for me" }).click();
  await expect(page.locator("#q")).toHaveValue("Why are people cancelling?");

  // Next goes to a server-rendered page; the card comes along and outlines the rule it is about.
  await card(page).getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/\/dashboard\/guard/);
  await expect(card(page)).toContainText("Step 4 of");
  await expect(page.locator("#policy.kj-lit")).toBeVisible();
  await card(page).getByRole("button", { name: "Fill it in for me" }).click();
  await expect(page.locator("#policy textarea[name='text']")).toHaveValue(/three retention offers/);
  await expect(card(page).locator(".kj-why a")).toHaveAttribute("href", /^https:\/\//);
  await noSideScroll(page);
  await settled(page);
  await axe(page);
});

test("handing over to the member shows who you are now, in the member's colour", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start the guided journey" }).click();
  await expect(card(page)).toBeVisible();
  // Jump to the last owner step ("members"), then Next hands over to the member.
  const j = await (await page.request.post("/ui/journey", { data: { action: "go", i: 5 } })).json();
  expect(j.steps[5].id).toBe("members");
  await page.goto("/dashboard/members");
  await expect(card(page)).toContainText("Step 6 of");
  await card(page).getByRole("button", { name: "Next" }).click();
  const sw = page.locator(".kj-switch[data-role='member']");
  await expect(sw).toBeVisible();
  await expect(sw).toContainText("Switching to");
  // The member's first step is how a customer joins: the shop's PayPal buttons.
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  await expect(sw).toHaveCount(0);
  await expect(card(page)).toHaveAttribute("data-role", "member");
  await expect(page.locator("[data-tour='plans'].kj-lit")).toBeVisible();
  await card(page).getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(new RegExp(`/manage/${j.member.ref}`));
  await expect(page.locator("[data-tour='card'].kj-lit")).toBeVisible();
  await noSideScroll(page);
  await settled(page);
  await axe(page);

  // Shrinking keeps one line; ending removes it everywhere, and it stays gone after a reload.
  await card(page).getByRole("button", { name: "Shrink the guide" }).click();
  await expect(card(page).getByRole("button", { name: "Next" })).toHaveCount(0);
  await card(page).getByRole("button", { name: "Open the guide" }).click();
  await card(page).getByRole("button", { name: "End the journey" }).click();
  await expect(card(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
});

test("the place lives on the server: a second browser on the same shop picks it up", async ({ page, browser }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "as the member", exact: true }).click();
  await expect(card(page)).toHaveAttribute("data-role", "member");
  const cookies = await page.context().cookies();
  const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await other.addCookies(cookies);
  const p2 = await other.newPage();
  await p2.goto("/dashboard");
  await expect(p2.locator("#kept-journey")).toHaveAttribute("data-role", "member");
  await expect(p2.locator("#kept-journey")).toContainText("This step is on another page.");
  await other.close();
});

test("with no journey running, pages show no card", async ({ page }) => {
  for (const path of ["/", "/demo", "/s/ember-oak-coffee-club", "/paypal"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(card(page), path).toHaveCount(0);
  }
});
