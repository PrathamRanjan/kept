import { expect, test, type Page } from "@playwright/test";
import { axe, freshMember, noSideScroll, noTours } from "./helpers";

// Look and Say (hands-free) and the four-language switch, in a real browser. The camera, the microphone and the
// browser's speech recognition are stand-ins here (no face, no voice in CI); everything Kept decides is real.

/** A stand-in for the browser's speech recognition that the test "speaks" into, and a camera that is not there. */
async function fakeVoiceNoCamera(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    class FakeRec {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: any = null;
      onend: any = null;
      onerror: any = null;
      constructor() { w.__rec = this; }
      start() {}
      stop() {}
      abort() {}
    }
    w.SpeechRecognition = FakeRec;
    w.webkitSpeechRecognition = FakeRec;
    w.__say = (text: string) => w.__rec?.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (c?.video) throw new DOMException("no camera", "NotFoundError");
      return new AudioContext().createMediaStreamDestination().stream;
    };
  });
}
/** Hold Space (push-to-talk) and say something. */
async function sayWithSpace(page: Page, text: string) {
  // The playback gate: while Kept is speaking, only "stop" gets through, so wait for it to finish.
  await page.waitForFunction(() => !speechSynthesis.speaking, null, { timeout: 15_000 });
  await page.keyboard.down("Space");
  await page.evaluate((t) => (window as any).__say(t), text);
  await page.keyboard.up("Space");
}

test("language: switching keeps what you typed, updates the page and remembers the choice", async ({ page }) => {
  await noTours(page);
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}`);
  const h1 = await page.getByRole("heading", { level: 1 }).innerText();
  await page.locator("#negotiate-words").fill("only if it's under $15");
  await page.getByTestId("lang-picker").first().selectOption("pt-BR");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(h1);
  await expect(page.locator("#negotiate-words")).toHaveValue("only if it's under $15");
  await expect(page.getByText(/tradução automática|traduzido automaticamente|máquina/i).first()).toBeVisible();
  await page.goto(`/manage/${ref}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await page.getByTestId("lang-picker").first().selectOption("en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
});

for (const lang of ["hi-IN", "id-ID", "pt-BR"]) {
  test(`language: ${lang} member page has no sideways scroll and passes axe`, async ({ page }, info) => {
    await noTours(page);
    const ref = await freshMember(page);
    await page.goto(`/manage/${ref}?lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect(page.locator("[data-tour='card'] li").first()).toBeVisible();
    await noSideScroll(page);
    await axe(page);
    await page.screenshot({ path: `docs/screenshots/lang-${lang}-${info.project.name}.png`, fullPage: false });
  });
}

test("language: the pseudo-locale (accents, 30% longer) still fits", async ({ page }) => {
  await noTours(page);
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}?lang=qps`);
  await expect(page.locator("[data-tour='card'] li").first()).toBeVisible();
  await noSideScroll(page);
  for (const p of ["/", "/demo", "/proof"]) {
    await page.goto(`${p}?lang=qps`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("[");
    await noSideScroll(page);
  }
});

test("language: every public page follows the picker, and English comes back word for word", async ({ page }) => {
  await noTours(page);
  for (const p of ["/", "/demo", "/proof", "/accessibility"]) {
    await page.goto(p);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();
    const en = { h1: await h1.innerText(), title: await page.title(), ribbon: await page.getByRole("region", { name: "Demo notice" }).innerText() };
    await page.getByTestId("lang-picker").first().selectOption("id-ID");
    await expect(page.locator("html")).toHaveAttribute("lang", "id-ID");
    await expect(h1).not.toHaveText(en.h1);
    await expect(page.getByRole("region", { name: "Pemberitahuan demo" })).toContainText("Demo hackathon.");
    expect(await page.title()).not.toBe(en.title);
    await page.getByTestId("lang-picker").first().selectOption("en");
    await expect(h1).toHaveText(en.h1);
    expect(await page.title()).toBe(en.title);
    expect(await page.getByRole("region", { name: "Demo notice" }).innerText()).toBe(en.ribbon);
  }
});

for (const lang of ["hi-IN", "id-ID", "pt-BR"]) {
  test(`language: ${lang} landing, demo and proof pages fit and pass axe`, async ({ page }, info) => {
    await noTours(page);
    for (const p of ["/", "/demo", "/proof"]) {
      await page.goto(`${p}?lang=${lang}`);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (p === "/proof") await expect(page.getByTestId("pub-recorded")).toBeVisible();
      await noSideScroll(page);
      await axe(page);
    }
    await page.goto(`/?lang=${lang}`);
    await page.screenshot({ path: `docs/screenshots/lang-${lang}-landing-${info.project.name}.png`, fullPage: false });
  });
}

test("language: the member's scam-check page opens in the member's language and checks in it", async ({ page }) => {
  await noTours(page);
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}?lang=pt-BR`);
  await page.getByRole("link", { name: /Verificar uma mensagem|golpe/i }).first().click();
  await expect(page).toHaveURL(new RegExp(`/manage/${ref}/check\\?lang=pt-BR`));
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Esta mensagem é mesmo de");
  await page.getByRole("button", { name: "Colar o golpe de demonstração" }).click();
  await page.getByRole("button", { name: "Verificar esta mensagem" }).click();
  await expect(page.locator("#scan-result .banner")).toContainText(/Espere: não pague ainda|Atenção: confira antes de pagar/, { timeout: 60_000 });
  await expect(page.locator("#scan-result")).toContainText("3 · Código: para onde o dinheiro iria");
  await noSideScroll(page);
  await page.getByRole("link", { name: "Voltar à sua assinatura" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
});

test("talk before cancelling: two moves each, the referee checks, and nothing changes until you take it", async ({ page }) => {
  await noTours(page);
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}`);
  await page.locator("#negotiate-words").fill("too expensive, I'd stay if it were under $15 a month");
  await page.getByRole("button", { name: "Start the talk" }).click();
  await expect(page.getByText("The conversation")).toBeVisible();
  await expect(page.getByText(/Referee \(code\)/).first()).toBeVisible();
  await expect(page.getByText(/Nothing has changed yet/)).toBeVisible();
  const r = await page.request.get(`/ui/manage/${ref}`);
  const v = await r.json();
  expect(v.view.status).toBe("ACTIVE");
  expect(v.offer?.id).toBeTruthy();
});

test("hands-free: the camera-free simulation snaps, dwells and clicks", async ({ page }) => {
  await noTours(page);
  await page.goto("/accessibility");
  await page.getByTestId("hf-sim-run").click();
  await expect(page.getByTestId("hf-sim-out")).toHaveText("Clicked: Pause", { timeout: 10_000 });
});

test("hands-free: no camera means voice only; a money control needs a confirm card and a yes", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard push-to-talk is a desktop path");
  await noTours(page);
  await fakeVoiceNoCamera(page);
  const ref = await freshMember(page);
  await page.goto(`/manage/${ref}`);
  await page.getByTestId("hf-toggle").first().click();
  await page.getByLabel("Voice commands").check();
  await page.getByTestId("hf-start").click();
  await expect(page.getByTestId("hf-status")).toContainText(/voice only/);
  await page.getByRole("button", { name: "Close" }).click(); // closes the panel; hands-free stays on (Esc would stop it)
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-hf", "on");
  await axe(page);

  const cancel = page.locator("[data-tour='cancel']").getByRole("button", { name: "Cancel subscription" });
  await cancel.focus();
  await sayWithSpace(page, "click");
  const card = page.getByTestId("hf-confirm");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Cancel subscription");
  // Anything but "yes" is a no, and holding Space on the focused card never presses anything.
  await sayWithSpace(page, "click");
  await expect(card).toBeHidden();
  expect((await (await page.request.get(`/ui/manage/${ref}`)).json()).view.status).toBe("ACTIVE");

  await cancel.focus();
  await sayWithSpace(page, "this one");
  await expect(card).toBeVisible();
  await sayWithSpace(page, "yes");
  await expect(page.getByText(/Ended|cancelled/i).first()).toBeVisible();

  // "Stop" works with no wake word and no Space.
  await page.evaluate(() => (window as any).__say("stop"));
  await expect(page.locator("html")).not.toHaveAttribute("data-hf", "on");
});

test("hands-free: Alt+H toggles, Esc stops, and the debug list explains itself", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard shortcut is a desktop path");
  await noTours(page);
  await fakeVoiceNoCamera(page);
  await page.goto("/");
  await page.keyboard.press("Alt+KeyH");
  await expect(page.locator("html")).toHaveAttribute("data-hf", "on");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveAttribute("data-hf", "on");
  await page.getByTestId("hf-toggle").first().click();
  await expect(page.getByTestId("hf-start")).toBeVisible();
  await noSideScroll(page);
});
