import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** First-run tours would cover the page; tests that aren't about tours turn them off. */
export async function noTours(page: Page) {
  await page.addInitScript(() => ["owner", "member", "shop"].forEach((t) => localStorage.setItem(`kept-tour-seen-${t}`, "never")));
}

export async function freshMember(page: Page): Promise<string> {
  const r = await page.request.post("/__e2e/member");
  return (await r.json()).ref;
}

export async function noSideScroll(page: Page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(sw, "page scrolls sideways").toBeLessThanOrEqual(w);
}

/** WCAG 2.2 AA via axe: no serious or critical violations. */
export async function axe(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude(".b-calendar").exclude(".ag-root-wrapper").analyze();
  const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
}
