/**
 * Journey 43 (#953): the landing's only client island resolves Auth.js session
 * state without flashing the wrong CTA and progressively orchestrates the
 * already-complete server HTML. Session responses are intercepted so both
 * states stay deterministic without involving Google's OAuth UI.
 */
import { expect, test } from "./fixtures";

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
  await chat.scrollIntoViewIfNeeded();
  const typedAmount = chat.locator("strong");
  let typingStyle: { fontFamily: string; fontWeight: string } | null = null;
  let typingBox: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(
      async () => {
        if ((await page.locator("[data-chat-caret]").count()) !== 1) return false;
        const snapshot = await typedAmount.evaluate((element) => {
          const reveal = element.closest("[data-reveal]");
          if (reveal && Number.parseFloat(getComputedStyle(reveal).opacity) < 0.99)
            return null;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          if (element.textContent !== "1.847 €") return null;
          return {
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            style: { fontFamily: style.fontFamily, fontWeight: style.fontWeight },
          };
        });
        if (!snapshot) return false;
        typingBox = snapshot.box;
        typingStyle = snapshot.style;
        return true;
      },
      { timeout: 4_000 },
    )
    .toBe(true);

  await expect(page.locator("[data-chat-caret]")).toHaveCount(0, { timeout: 3_000 });
  const finalStyle = await typedAmount.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontWeight: style.fontWeight };
  });
  expect(finalStyle).toEqual(typingStyle);
  expect(await typedAmount.boundingBox()).toEqual(typingBox);
});
