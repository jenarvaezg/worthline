/**
 * Journey 42 (#951, PRD #877): the public landing is whole without JS. The
 * browser runs with JavaScript disabled, so anything that reaches the screen
 * is server-rendered static HTML — the reading experience the static
 * invariant promises. The session island and animations (S5) must layer on
 * top of this baseline, never replace it.
 */
import { expect, test } from "./fixtures";

test.use({ javaScriptEnabled: false });

test("landing: the 9 sections read fully with JavaScript disabled", async ({ page }) => {
  await page.goto("/");

  // La cubierta: H1, lede y CTAs.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Evoluciona tu Excel",
  );
  await expect(page.getByText("en una sola imagen")).toBeVisible();

  // La hoja encartada llega con su cifra final en el DOM (sin JS que la anime).
  // La cifra también vive en el bloque MCP, así que se ancla a la hoja (figure).
  await expect(page.getByText("Neto total")).toBeVisible();
  await expect(
    page.getByRole("figure").getByText("251.527 €", { exact: true }),
  ).toBeVisible();

  // Los asientos, en orden de lectura.
  for (const headline of [
    "De tu hoja… a worthline",
    "¿Está funcionando de verdad tu cartera?",
    "Actualizar deja de ser un trabajo",
    "Tus cifras, cerradas y tuyas.",
    "Habla con tu patrimonio. Y que te responda con la cifra exacta.",
    "Tu patrimonio, leíble por tu agente.",
    "Tu Excel ya hizo su trabajo",
  ]) {
    await expect(page.getByRole("heading", { name: headline })).toBeAttached();
  }

  // La respuesta del chat está completa en el DOM, no tecleada por JS.
  await expect(page.locator("[data-chat-visual]")).toContainText("En 2025 cobraste");

  // Coreografía de CTAs: empezar (hero + cierre) y demo.
  await expect(page.getByRole("link", { name: "Empezar con mis datos" })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Entrar" })).toHaveAttribute(
    "href",
    "/login",
  );
});

test("landing: the no-JS masthead fits at 375px with one visible Entrar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const masthead = page.locator("header").first();
  const entry = masthead.getByRole("link", { name: "Entrar", exact: true });
  await expect(entry).toHaveCount(1);
  await expect(entry).toBeVisible();
  expect(
    await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toEqual({ innerWidth: 375, scrollWidth: 375 });
});
