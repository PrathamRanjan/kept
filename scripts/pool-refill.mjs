#!/usr/bin/env node
/**
 * Creates N subscriptions for the approval pool on the live site and prints their PayPal approval links.
 *   KEPT_URL=https://pph-kept.onrender.com KEPT_ADMIN_KEY=... node scripts/pool-refill.mjs 5
 * Approve each link as the sandbox buyer (or run scripts/sandbox-approver.mjs), then the hourly pool read-back
 * (or "Read the pool back from PayPal" on /admin/pool) marks them ready.
 */
const base = process.env.KEPT_URL || "https://pph-kept.onrender.com";
const key = process.env.KEPT_ADMIN_KEY;
if (!key) {
  console.error("Set KEPT_ADMIN_KEY.");
  process.exit(1);
}
const n = Number(process.argv[2] || 5);
const res = await fetch(`${base}/admin/pool/refill`, { method: "POST", headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: `n=${n}` });
if (!res.ok) {
  console.error(`Refill failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const out = await res.json();
console.log(`Created ${out.created.length} on ${out.plan}. Approve each as the sandbox buyer:`);
for (const i of out.created) console.log(`${i.paypal_id}  ${i.approve_url}`);
