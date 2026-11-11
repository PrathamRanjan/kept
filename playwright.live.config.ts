import { defineConfig } from "@playwright/test";

/**
 * Spec A12, the robot judge: a browser that follows the /judge paths on the live site, the way a judge would, and
 * writes what it saw to eval/robot-judge.json. It never uses a pre-approved PayPal subscription, never takes a
 * visitor's demo slot and never signs in to PayPal.   npm run robot:judge   (ROBOT_BASE to point it elsewhere)
 */
export default defineConfig({
  testDir: "e2e-live",
  timeout: 420_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.ROBOT_BASE || "https://pph-kept.onrender.com", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
