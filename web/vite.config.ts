import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built to web/dist and served by the Express app (src/web/spa.ts). In dev, API calls proxy to the Express server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  base: "/",
  build: { outDir: "dist", assetsDir: "assets", sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { "^/(ui|api|static|login|logout|dashboard|onboard|webhooks|mcp|s/[^/]+/mcp|manage/[^/]+/(check|connect)|trace|judge/reset|healthz|llms.txt|skill.md|openapi.yaml)": "http://localhost:4112" } },
});
