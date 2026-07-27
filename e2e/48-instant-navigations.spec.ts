/**
 * Journey 48: Instant Navigations across the five workspace tabs (#1229).
 *
 * Asserts that soft clicks between Resumen / Patrimonio / Histórico /
 * Objetivos / Ajustes paint the prefetched shell (chrome + Suspense skeleton)
 * without waiting for dynamic data — the executable form of ADR 0036's
 * «¿la navegación va sin flash?» checklist under Cache Components +
 * Partial Prefetching.
 */
import { instant } from "@next/playwright";
import { expect, test } from "./fixtures";

const TABS = [
  {
    href: "/patrimonio",
    name: "Patrimonio",
    skeleton: /Cargando patrimonio/i,
  },
  {
    href: "/historico",
    name: "Histórico",
    skeleton: /Cargando histórico/i,
  },
  {
    href: "/objetivos",
    name: "Objetivos",
    skeleton: /Cargando objetivos/i,
  },
  {
    href: "/ajustes",
    name: "Ajustes",
    skeleton: /Cargando ajustes/i,
  },
  {
    href: "/app",
    name: "Resumen",
    skeleton: /Cargando panel de resumen/i,
  },
] as const;

test("five workspace tabs paint shell + skeleton instantly on soft navigation", async ({
  page,
}) => {
  // Partial Prefetching only warms shells under `next start`; local e2e uses
  // `next dev`, where the instant() helper has nothing cached to assert on.
  test.skip(!process.env.CI, "requires production prefetch (CI runs next start)");

  await page.goto("/demo?persona=familia");
  await expect(page).toHaveURL(/\/app$/);

  // Warm the Partial Prefetching shells: each tab link in the viewport gets
  // one shell prefetch. Give production-mode prefetch a beat to settle.
  const nav = page.getByRole("navigation", { name: "Secciones principales" });
  await expect(nav).toBeVisible();
  await page.waitForTimeout(500);

  for (const tab of TABS) {
    await instant(page, async () => {
      await nav.getByRole("link", { name: tab.name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(tab.href.replace("/", "\\/") + "$"));
      // Chrome stays mounted (#1190) and the route skeleton is the instant shell.
      await expect(nav).toBeVisible();
      await expect(page.getByLabel(tab.skeleton)).toBeVisible();
    });

    // After instant() releases, dynamic content replaces the skeleton.
    await expect(page.getByLabel(tab.skeleton)).toHaveCount(0, { timeout: 30_000 });
    await expect(nav.getByRole("link", { name: tab.name, exact: true })).toHaveClass(
      /active/,
    );
  }
});
