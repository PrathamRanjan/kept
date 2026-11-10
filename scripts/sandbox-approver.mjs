#!/usr/bin/env node
/**
 * Approves every pool subscription that is waiting for the sandbox buyer, in a real browser (Playwright).
 * Run it yourself, in your own shell: the buyer's password goes in an environment variable and never into
 * Kept, a file or a log. Kept's code never handles it.
 *
 *   KEPT_URL=https://pph-kept.onrender.com KEPT_ADMIN_KEY=... \
 *   PAYPAL_SANDBOX_BUYER_EMAIL=sb-...@personal.example.com PAYPAL_SANDBOX_BUYER_PASSWORD=... \
 *   node scripts/sandbox-approver.mjs [--headed]
 */
import { chromium } from "playwright";

const base = process.env.KEPT_URL || "https://pph-kept.onrender.com";
const { KEPT_ADMIN_KEY: key, PAYPAL_SANDBOX_BUYER_EMAIL: email, PAYPAL_SANDBOX_BUYER_PASSWORD: password } = process.env;
if (!key || !email || !password) {
  console.error("Set KEPT_ADMIN_KEY, PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD.");
  process.exit(1);
}
const auth = { authorization: `Bearer ${key}`, accept: "application/json" };
const pool = await (await fetch(`${base}/admin/pool.json`, { headers: auth })).json();
const waiting = pool.items.filter((i) => i.status === "awaiting_approval" && i.approve_url);
console.log(`${waiting.length} waiting for approval.`);
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const ctx = await browser.newContext();
const page = await ctx.newPage();
let signedIn = false;
for (const item of waiting) {
  try {
    await page.goto(item.approve_url, { waitUntil: "domcontentloaded" });
    if (!signedIn) {
      const emailBox = page.locator("#email");
      if (await emailBox.isVisible({ timeout: 15000 }).catch(() => false)) {
        await emailBox.fill(email);
        const next = page.locator("#btnNext");
        if (await next.isVisible().catch(() => false)) await next.click();
        await page.locator("#password").fill(password);
        await page.locator("#btnLogin").click();
      }
      signedIn = true;
    }
    const agree = page.getByRole("button", { name: /Agree & Subscribe|Agree and Subscribe|Subscribe|Continue/i }).first();
    await agree.waitFor({ timeout: 30000 });
    await agree.click();
    await page.waitForURL(/\/demo\/pool\/approved/, { timeout: 60000 });
    console.log(`approved ${item.paypal_id}`);
  } catch (e) {
    console.log(`could not approve ${item.paypal_id}: ${e.message.split("\n")[0]}`);
  }
}
await browser.close();
const sync = await (await fetch(`${base}/admin/pool/sync`, { method: "POST", headers: auth })).json();
console.log(`Pool read back from PayPal: ${sync.ready} ready, ${sync.spent} spent, ${sync.errors} errors.`);
