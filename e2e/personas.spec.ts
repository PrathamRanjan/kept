import { expect, test } from "@playwright/test";
import { axe, freshMember, noSideScroll, noTours } from "./helpers";

test.beforeEach(async ({ page }) => noTours(page));

test("landing: hero, why it exists, the four criteria, planned pricing, and the guided demo starts from it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("because leaving takes one tap");
  // The phone in the hero is an illustration and says so; pricing is planned and says so.
  await expect(page.getByText(/illustration/i).first()).toBeVisible();
  await expect(page.getByText(/Planned pricing/).first()).toBeVisible();
  for (const h of ["Technological implementation", "Design", "Potential impact", "Innovation"]) await expect(page.getByRole("heading", { name: h, exact: true })).toBeVisible();
  await expect(page.getByText("For judges")).toHaveCount(0);
  await noSideScroll(page);
  await axe(page);
  await page.getByRole("button", { name: "Start the guided demo" }).first().click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator("#kept-journey")).toContainText("Step 1 of");
  await page.locator("#kept-journey").getByRole("button", { name: "End the journey" }).click();
  await page.goto("/demo");
  await expect(page.getByRole("button", { name: "Start the guided journey" })).toBeVisible();
  await noSideScroll(page);
});

test("new subscriber: shop page hands off to PayPal's approval page", async ({ page }) => {
  await page.goto("/s/ember-oak-coffee-club");
  await expect(page.getByRole("heading", { name: "Ember & Oak Coffee Club" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Our promise" })).toBeVisible();
  await noSideScroll(page);
  await axe(page);
  await page.route(/sandbox\.paypal\.com/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>PayPal approval</title><h1>PayPal approval</h1>" }));
  const card = page.locator("form").filter({ hasText: "Signature bag" });
  await card.getByLabel("Your name").fill("Pat Example");
  await card.getByRole("button", { name: /Subscribe with PayPal/ }).click();
  await expect(page).toHaveURL(/sandbox\.paypal\.com/);
});

test("member: skip, pause, resume, then one-step cancel, each with a trace", async ({ page }) => {
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("your subscription");
  await expect(page.locator("[data-tour='card'] li").first()).toBeVisible();
  await noSideScroll(page);
  await axe(page);

  // A skip suspends on PayPal until the cycle after next, so the card shows a scheduled skipped stamp and Resume.
  await page.getByRole("button", { name: "Skip next payment" }).click();
  await expect(page.getByText(/Skipped \(scheduled\)/).first()).toBeAttached();
  await expect(page.locator("[data-tour='history']")).toContainText(/PayPal/);
  await page.getByRole("button", { name: "Resume now" }).click();
  await expect(page.getByRole("button", { name: /^Pause$/ })).toBeEnabled();

  await page.getByRole("button", { name: /^Pause$/ }).click();
  await expect(page.getByRole("button", { name: "Resume now" })).toBeVisible();
  await page.getByRole("button", { name: "Resume now" }).click();
  await expect(page.getByRole("button", { name: /^Pause$/ })).toBeEnabled();

  const cancel = page.locator("[data-tour='cancel']");
  await expect(cancel.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
  // Never red: the cancel button uses ink, not the failure colour.
  const bg = await cancel.getByRole("button", { name: "Cancel subscription" }).evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(bg).not.toMatch(/rgb\(1[5-9]\d|2\d\d, [0-6]\d, [0-6]\d\)/);
  await cancel.getByRole("button", { name: "Cancel subscription" }).click();
  await expect(page.getByText(/Ended|cancelled/i).first()).toBeVisible();
  await expect(page.locator("[data-tour='history']")).toContainText(/cancel/i);
});

test("member: asking for an offer shows one offer; declining cancels at once", async ({ page }) => {
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}`);
  const cancel = page.locator("[data-tour='cancel']");
  await cancel.getByRole("checkbox").check();
  await cancel.getByRole("button", { name: /See one offer, or cancel/ }).click();
  const offer = page.getByRole("heading", { name: "One offer before you go" });
  await expect(offer).toBeVisible();
  await page.getByRole("button", { name: "No thanks, cancel now" }).click();
  await expect(page.getByText(/Ended|cancelled/i).first()).toBeVisible();
});

test("owner: today, ask, approvals and members", async ({ page, isMobile }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Open the owner's dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Today at Ember & Oak");
  await expect(page.locator("[data-tour='kpis']")).toContainText("Live members");
  await noSideScroll(page);
  await axe(page);

  await page.getByRole("button", { name: "Who has a failed payment?" }).click();
  await expect(page.locator("[data-tour='ask']")).toContainText(/payment|nobody|no one|none/i, { timeout: 15_000 });

  await page.goto("/dashboard/approvals");
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  await noSideScroll(page);
  await axe(page);

  await page.goto("/dashboard/members");
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  if (isMobile) await expect(page.getByRole("link", { name: /Maya Chen|Ada|Grace|Test Member/ }).first()).toBeVisible();
  else await expect(page.locator(".ag-row").first()).toBeVisible();
  await noSideScroll(page);
});

test("unknown page shows a helpful not-found", async ({ page }) => {
  await page.goto("/manage/not-a-real-ref");
  await expect(page.getByText(/couldn't find|not found|doesn't exist/i).first()).toBeVisible();
});
