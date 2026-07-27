/**
 * Journey 43 (#953): the landing's only client island resolves Auth.js session
 * state without flashing the wrong CTA and progressively orchestrates the
 * already-complete server HTML. Session responses are intercepted so both
 * states stay deterministic without involving Google's OAuth UI.
 */
import { expect, test } from "./fixtures";

/**
 * One frame of the typing animation, as the page recorded it. Declared out here
 * (rather than with `declare global`) so nothing in this file widens the shared
 * `Window` type for every other spec.
 */
interface ChatTypingFrame {
  caret: boolean;
  box: { x: number; y: number; width: number; height: number };
  style: { fontFamily: string; fontWeight: string };
}

interface ChatTypingWindow extends Window {
  chatTypingFrames?: ChatTypingFrame[];
}

async function holdSessionResponse(
  page: import("@playwright/test").Page,
  body: Record<string, unknown>,
) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/api/auth/session", async (route) => {
    await gate;
    await route.fulfill({ contentType: "application/json", json: body, status: 200 });
  });

  return release;
}

test("landing CTAs work and the logged-out session state never flashes logged-in copy", async ({
  page,
}) => {
  const releaseSession = await holdSessionResponse(page, {});
  await page.goto("/");

  const sessionSlot = page.locator("[data-session-slot]");
  await expect(sessionSlot.getByRole("link")).toHaveCount(0);
  const reservedWidth = await sessionSlot.evaluate(
    (element) => element.getBoundingClientRect().width,
  );

  releaseSession();
  await expect(sessionSlot.getByRole("link", { name: "Entrar" })).toHaveAttribute(
    "href",
    "/login",
  );
  await expect
    .poll(() => sessionSlot.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(reservedWidth);

  await expect(page.getByRole("link", { name: "Empezar con mis datos" })).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "Empezar con mis datos" }).first(),
  ).toHaveAttribute("href", "/login?returnTo=/app");
  await expect(page.getByRole("link", { name: "Explorar la demo" })).toHaveCount(3);
  await expect(
    page.getByRole("link", { name: "Velo en la demo" }).first(),
  ).toHaveAttribute("href", "/demo");

  await page.getByRole("link", { name: "Empezar con mis datos" }).first().click();
  await expect(page).toHaveURL(/\/login\?returnTo=\/app$/);
  await page.goBack();

  await page.getByRole("link", { name: "Velo en la demo" }).first().click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole("heading", { name: "Joven" })).toBeVisible();
});

test("the same neutral slot resolves a logged-in Auth.js session to the panel", async ({
  page,
}) => {
  const releaseSession = await holdSessionResponse(page, {
    user: { email: "jose@example.com", name: "Jose" },
  });
  await page.goto("/");

  const sessionSlot = page.locator("[data-session-slot]");
  await expect(sessionSlot.getByRole("link")).toHaveCount(0);
  await expect(sessionSlot.locator('[aria-hidden="true"]')).toBeHidden();

  releaseSession();
  await expect(sessionSlot.getByRole("link", { name: "Ir a mi panel" })).toHaveAttribute(
    "href",
    "/app",
  );
});

test("motion off is final and static, including live preference changes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ contentType: "application/json", json: {}, status: 200 }),
  );
  await page.goto("/");

  await expect(page.locator("[data-net-figure]")).toHaveText("251.527 €");
  await expect(page.locator("[data-chat-visual]")).toContainText(
    "En 2025 cobraste 1.847 €",
  );
  const semanticAnswer = page.locator("[data-chat-semantic]");
  await expect(semanticAnswer).toContainText("En 2025 cobraste 1.847 €");
  const semanticHtml = await semanticAnswer.innerHTML();
  await expect(page.locator("[data-chat-caret]")).toHaveCount(0);
  expect(
    await page
      .locator("header")
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, transitionDuration: style.transitionDuration };
      }),
  ).toEqual({ opacity: "1", transitionDuration: "0s" });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("[data-net-figure]")).toHaveText("251.527 €");
  await expect(page.locator("[data-chat-caret]")).toHaveCount(0);
  expect(await semanticAnswer.innerHTML()).toBe(semanticHtml);
});

test("normal motion never hides reveal content before scrolling", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ contentType: "application/json", json: {}, status: 200 }),
  );
  await page.goto("/");

  const reveals = page.locator("[data-reveal]");
  expect(await reveals.count()).toBeGreaterThan(0);
  expect(
    await reveals.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).opacity),
    ),
  ).toEqual((await reveals.all()).map(() => "1"));
});

test("normal motion starts without waiting for fonts and settles without a type jump", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ contentType: "application/json", json: {}, status: 200 }),
  );

  let releaseFonts = () => {};
  const fontsGate = new Promise<void>((resolve) => {
    releaseFonts = resolve;
  });
  await page.route("**/*.woff2", async (route) => {
    await fontsGate;
    await route.continue();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const headline = page.getByRole("heading", { name: "Evoluciona tu Excel." });
  const net = page.locator("[data-net-figure]");
  const primaryCta = page.getByRole("link", { name: "Empezar con mis datos" }).first();
  const primaryCtaStage = primaryCta.locator("..");

  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loading");
  await expect
    .poll(() => headline.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
  await expect
    .poll(() =>
      primaryCtaStage.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, transitionDuration: style.transitionDuration };
      }),
    )
    .toEqual({ opacity: "1", transitionDuration: "0.38s, 0.38s" });
  await expect(net).toHaveText("251.527 €", { timeout: 2_000 });
  expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
  releaseFonts();
  await page.evaluate(() => document.fonts.ready);

  const chat = page.locator("[data-chat-visual]");
  // The typed amount is complete-but-still-typing for a WINDOW, not forever: the
  // orchestrator retypes the line one character every 18 ms and drops the caret on
  // the last one, so «1.847 €» reads complete for the ~800 ms it takes to type the
  // rest of the sentence. Polling from the test sampled that window from outside
  // and lost the race whenever a round-trip landed late — three consecutive reds on
  // main with the run green on the same tree. So the page records every frame
  // instead: a MutationObserver sees all of them, and the assertion runs on the
  // film afterwards.
  await page.evaluate(() => {
    const visual = document.querySelector("[data-chat-visual]");
    if (!visual) return;
    const frames: ChatTypingFrame[] = [];
    (window as ChatTypingWindow).chatTypingFrames = frames;
    const record = () => {
      const amount = visual.querySelector("strong");
      if (!amount || amount.textContent !== "1.847 €") return;
      // Skip frames while the entry is still sliding in. Its opacity finishes in
      // 0.38s but the transform takes 0.55s, and the tail of that ease moves the
      // amount by half a pixel — which is not the font swap this test is about.
      const reveal = amount.closest("[data-reveal]");
      if (reveal) {
        const revealStyle = getComputedStyle(reveal);
        if (Number.parseFloat(revealStyle.opacity) < 0.99) return;
        const settled =
          revealStyle.transform === "none" ||
          revealStyle.transform === "matrix(1, 0, 0, 1, 0, 0)";
        if (!settled) return;
      }
      const rect = amount.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const style = getComputedStyle(amount);
      frames.push({
        caret: visual.querySelector("[data-chat-caret]") !== null,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style: { fontFamily: style.fontFamily, fontWeight: style.fontWeight },
      });
    };
    new MutationObserver(record).observe(visual, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });

  await chat.scrollIntoViewIfNeeded();
  const typedAmount = chat.locator("strong");
  // Waiting on the caret's ABSENCE would be satisfied before a single character is
  // typed. The recorded count only grows, so polling it can never miss its moment.
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as ChatTypingWindow).chatTypingFrames?.length ?? 0),
      { timeout: 8_000 },
    )
    .toBeGreaterThan(0);
  await expect(page.locator("[data-chat-caret]")).toHaveCount(0, { timeout: 8_000 });
  await expect(typedAmount).toHaveText("1.847 €");

  const typingFrames = await page.evaluate(
    () =>
      (window as ChatTypingWindow).chatTypingFrames?.filter((frame) => frame.caret) ?? [],
  );
  // Without this the test could pass by never having watched anything type.
  expect(typingFrames.length).toBeGreaterThan(0);

  const finalStyle = await typedAmount.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontWeight: style.fontWeight };
  });
  const finalBox = await typedAmount.boundingBox();
  for (const frame of typingFrames) {
    expect(frame.style).toEqual(finalStyle);
    expect(frame.box).toEqual(finalBox);
  }
});
