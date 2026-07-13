/**
 * Route contract (#861, #949, estreno #954): the public landing at `/`, the
 * dashboard at `/app`, the auth gate with a safe `returnTo`, and the demo seed
 * landing on `/app`. The estreno retired the provisional `/` → `/app` 307: `/`
 * now serves the static landing and no longer bounces visitors to the dashboard.
 *
 * Auth-gated redirects run in playwright.routing.config.ts (auth env on).
 * Redirects that work in no-auth mode run here in the main serial suite.
 */
import { expect, test } from "./fixtures";

test.describe("route migration — no-auth mode", () => {
  test("/ serves the public landing (estreno #954), not a redirect to /app", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Evoluciona tu Excel",
    );
  });

  test("/ no longer redirects, even with legacy query params", async ({ request }) => {
    const response = await request.get("/?view=liquid&drill=liquid", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
  });

  test("dashboard renders at /app", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("worthline");
  });

  test("manifest start_url points at /app", async ({ request }) => {
    const manifest = await (await request.get("/manifest.json")).json();
    expect(manifest.start_url).toBe("/app");
  });

  test("demo persona seed lands on /app", async ({ page }) => {
    await page.goto("/demo/persona?persona=familia");
    await expect(page).toHaveURL(/\/app/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("worthline");
    await expect(page.getByRole("note", { name: "Modo demostración" })).toBeVisible();
  });
});
