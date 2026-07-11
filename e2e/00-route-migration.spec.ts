/**
 * Route migration contract (#861, #949): dashboard at `/app`, provisional `/`
 * → `/app`, auth gate with safe `returnTo`, demo seed landing on `/app`.
 *
 * Auth-gated redirects run in playwright.routing.config.ts (auth env on).
 * Redirects that work in no-auth mode run here in the main serial suite.
 */
import { expect, test } from "./fixtures";

test.describe("route migration — no-auth mode", () => {
  test("/ → 307 /app (provisional root redirect)", async ({ request }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toBe("/app");
  });

  test("dashboard renders at /app", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("worthline");
  });

  test("manifest start_url points at /app", async ({ request }) => {
    const manifest = await (await request.get("/manifest.json")).json();
    expect(manifest.start_url).toBe("/app");
  });
});
