/**
 * Auth-gated route contract (#861, #949) — runs with AUTH_GOOGLE_* set so the
 * proxy gate engages. No real Google sign-in: we assert redirect targets only.
 */
import { expect, test } from "@playwright/test";

test.describe("route migration — auth gate", () => {
  test("unauthenticated /app → /login?returnTo=/app", async ({ request }) => {
    const response = await request.get("/app", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    const location = response.headers().location ?? "";
    expect(location).toMatch(/\/login\?returnTo=%2Fapp$/);
  });

  test("unauthenticated /patrimonio → /login?returnTo=/patrimonio", async ({
    request,
  }) => {
    const response = await request.get("/patrimonio", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    const location = response.headers().location ?? "";
    expect(location).toMatch(/\/login\?returnTo=%2Fpatrimonio$/);
  });

  test("/login rejects open-redirect returnTo (hostile query is not echoed)", async ({
    page,
  }) => {
    await page.goto("/login?returnTo=https%3A%2F%2Fevil.example.com%2F");
    await expect(
      page.getByRole("button", { name: /Iniciar sesión con Google/ }),
    ).toBeVisible();
    // The page must not navigate away to the hostile URL while logged out.
    await expect(page).toHaveURL(/\/login/);
  });

  test("public / serves the landing without a login bounce (estreno #954)", async ({
    request,
  }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });

  test("public /demo stays reachable without login", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.getByRole("heading", { name: "Joven" })).toBeVisible();
  });
});
