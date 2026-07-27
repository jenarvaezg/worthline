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
import type { Page, Response } from "@playwright/test";
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

/** True when a network response looks like a Partial Prefetch shell for `href`. */
function isShellPrefetch(response: Response, href: string): boolean {
  if (!response.ok()) return false;
  const url = new URL(response.url());
  const pathMatches = url.pathname === href || url.pathname.startsWith(`${href}/`);
  if (!pathMatches) return false;
  const contentType = response.headers()["content-type"] ?? "";
  return (
    url.searchParams.has("_rsc") ||
    contentType.includes("text/x-component") ||
    contentType.includes("rsc")
  );
}

/**
 * Wait until each off-current tab has received at least one shell prefetch.
 * Prefer this over a fixed timer: CI load varies and this suite runs with
 * `retries: 0`.
 */
async function waitForTabShellPrefetches(page: Page, currentHref: string): Promise<void> {
  const pending = TABS.filter((tab) => tab.href !== currentHref).map((tab) =>
    page.waitForResponse((response) => isShellPrefetch(response, tab.href), {
      timeout: 15_000,
    }),
  );
  await Promise.all(pending);
}

test("five workspace tabs paint shell + skeleton instantly on soft navigation", async ({
  page,
}) => {
  // Partial Prefetching only warms shells under `next start`; local e2e uses
  // `next dev`, where the instant() helper has nothing cached to assert on.
  // Force with CI=1 (and a prior `next build`) to reproduce locally.
  test.skip(!process.env.CI, "requires production prefetch (CI runs next start)");

  // Arm prefetch waiters before navigation so we cannot miss in-flight shells.
  const warmed = waitForTabShellPrefetches(page, "/app");
  await page.goto("/demo?persona=familia");
  await expect(page).toHaveURL(/\/app$/);

  const nav = page.getByRole("navigation", { name: "Secciones principales" });
  await expect(nav).toBeVisible();
  // Nav must already be in the static shell (fallback links), not pop in later.
  await expect(nav.getByRole("link")).toHaveCount(5);
  await warmed;

  for (const tab of TABS) {
    await instant(page, async () => {
      await nav.getByRole("link", { name: tab.name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${tab.href.replace("/", "\\/")}$`));
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
