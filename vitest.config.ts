import { defineConfig } from "vitest/config";
// KEPT_SPA=off: these suites check the server-rendered pages, which stay as the fallback. The React UI is covered by Playwright (e2e/).
export default defineConfig({ test: { environment: "node", testTimeout: 30000, hookTimeout: 30000, include: ["test/**/*.test.ts"], env: { KEPT_SPA: "off" } } });
