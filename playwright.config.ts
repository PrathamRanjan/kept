import { defineConfig, devices } from "@playwright/test";

/** Browser tests run against e2e/server.ts: the real app on an in-memory DB with FakePayPal. Build web/ first. */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:4199", trace: "retain-on-failure" },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: "tsx e2e/server.ts",
    url: "http://localhost:4199/ui/session",
    reuseExistingServer: !process.env.CI,
    env: { PORT: "4199", APP_URL: "http://localhost:4199", KEPT_BRAIN: "local", KEPT_DEMO_MODE: "true", KEPT_INLINE_WORKER: "false", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", OPENAI_API_KEY: "", DATABASE_URL: "" },
  },
});
