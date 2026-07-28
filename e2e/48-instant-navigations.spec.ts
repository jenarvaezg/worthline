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

/** The cookie `instant()` writes to acquire the navigation lock. */
const INSTANT_COOKIE = "next-instant-navigation-testing";

/**
 * Whether the app took the navigation lock this scope asked for.
 *
 * `instant()` only sets a cookie; honouring it is the client bundle's job, and
 * Next compiles that code out of a production build unless
 * `experimental.exposeTestingApiInProductionBuild` is on (`build:e2e` sets it via
 * WORTHLINE_EXPOSE_TESTING_API). Without it the helper is inert and every
 * assertion below silently becomes a race against the server — green wherever
 * the server is slow, red wherever it answers before React paints the shell
 * (#1229).
 *
 * The observable difference is the cookie itself: the external actor writes a
 * two-entry «pending» value, and a build that owns the lock rewrites it with a
 * third entry (the captured navigation). So «captured» means the lock is real.
 */
async function instantLockState(page: Page): Promise<"absent" | "pending" | "captured"> {
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === INSTANT_COOKIE,
  );
  if (cookie === undefined) return "absent";
  try {
    const parsed: unknown = JSON.parse(cookie.value);
    return Array.isArray(parsed) && parsed.length >= 3 ? "captured" : "pending";
  } catch {
    return "pending";
  }
}

test("five workspace tabs paint shell + skeleton instantly on soft navigation", async ({
  page,
}) => {
  // Partial Prefetching only warms shells under `next start`; local e2e uses
  // `next dev`, where the instant() helper has nothing cached to assert on.
  // Reproduce locally with `bun run --filter @worthline/web build:e2e` (plain
  // `build` leaves the testing API out — see `instantLockState`) and CI=1.
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
      // Assert the lock before the shell: an inert instant() would otherwise fail
      // as a mystery skeleton flake instead of naming the build flag.
      await expect
        .poll(() => instantLockState(page), {
          message:
            "instant() never took the navigation lock: build the app with " +
            "`bun run --filter @worthline/web build:e2e` (it sets " +
            "WORTHLINE_EXPOSE_TESTING_API=1). A plain production build compiles " +
            "the Instant Navigation Testing API out and this journey degrades " +
            "into a race against the server.",
          timeout: 5_000,
        })
        .toBe("captured");
      await expect(page.getByLabel(tab.skeleton)).toBeVisible();
    });

    // After instant() releases, dynamic content replaces the skeleton.
    await expect(page.getByLabel(tab.skeleton)).toHaveCount(0, { timeout: 30_000 });
    await expect(nav.getByRole("link", { name: tab.name, exact: true })).toHaveClass(
      /active/,
    );
  }
});
