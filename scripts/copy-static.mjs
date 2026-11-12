// public/ and docs/ are served from the repo root in production too. The one copy: MediaPipe's face-tracker
// runtime (Apache 2.0, from the @mediapipe/tasks-vision package) into public/handsfree/wasm, so hands-free pointing
// loads from Kept itself (the service worker caches /static/, so a second load needs no download). Too large to commit.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const from = join("web", "node_modules", "@mediapipe", "tasks-vision", "wasm");
const to = join("public", "handsfree", "wasm");
if (!existsSync(from)) {
  console.error(`hands-free: ${from} is missing; run npm --prefix web ci first`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) copyFileSync(join(from, f), join(to, f));
console.log(`static assets served from ./public; face-tracker runtime copied to ${to}`);
