import { expect, test } from "@playwright/test";
import { noTours } from "./helpers";

// The real face tracker (MediaPipe, served by Kept itself) loading in Chrome with Chrome's fake camera. The fake
// camera shows a test pattern, not a face: the debug list says so, nothing is pointed at, and the off switch works.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }, permissions: ["camera", "microphone"] });

test("hands-free: the face tracker loads from Kept's own files, sees no face, and turns off", async ({ page, isMobile }) => {
  test.skip(isMobile, "one browser is enough for the tracker");
  test.setTimeout(90_000);
  await noTours(page);
  const external: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost" && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) external.push(u.hostname);
  });
  await page.goto("/");
  await page.getByTestId("hf-toggle").first().click();
  await page.getByTestId("hf-start").click();
  await expect(page.getByTestId("hf-indicator")).toContainText("Camera on", { timeout: 60_000 });
  await expect(page.getByTestId("hf-debug")).toContainText("no face in view");
  await expect(page.getByTestId("hf-outline")).toBeHidden();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByTestId("hf-indicator").getByRole("button", { name: "Turn the camera off" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-hf", "on");
  // The camera is really released, not just hidden.
  expect(await page.evaluate(() => [...document.querySelectorAll("video")].every((v) => !(v.srcObject as MediaStream | null)?.getTracks().some((t) => t.readyState === "live")))).toBe(true);
  // Nothing went to another host: the model and runtime came from /static/handsfree.
  expect(external.filter((h) => !/fonts\.(googleapis|gstatic)\.com$/.test(h))).toEqual([]);
});
