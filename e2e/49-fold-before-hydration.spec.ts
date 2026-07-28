/**
 * Journey 49: a native fold toggled BEFORE hydration keeps the tree intact (#1270).
 *
 * ADR 0009 folds are plain `<details>`: they work with zero client JS, so the
 * browser — not React — owns the `open` attribute. A person on a slow connection
 * can therefore toggle a fold before the page hydrates. The server HTML then says
 * «closed» while the DOM says «open», and React reports an attribute mismatch it
 * explicitly refuses to patch up:
 *
 *   A tree hydrated but some attributes of the server rendered HTML didn't match
 *   the client properties. This won't be patched up.
 *
 * That `console.error` is what tinted 5–6 journeys red under `next dev`, where the
 * on-demand chunk compile widens the window to seconds (#1270). It is not a test
 * artefact: the same window exists in production on a bad network, only narrower.
 * So the fix is in the app — every fold declares that the DOM owns its `open`
 * attribute — and this journey is the executable form of that claim.
 *
 * The window is reproduced deterministically instead of raced: hold the route's JS
 * chunks, toggle, release. That way this guards the production build in CI too,
 * not just the wide window of `next dev`.
 *
 * Only the closed→open direction is exercised here, because that is the one the
 * suite reported. The other one is real too — a fold the server sent OPEN, clicked
 * shut before hydration — and it needs no second journey: the declaration is per
 * element and unconditional, so `fold-hydration-guardian.test.ts` covers every fold
 * in the app for both directions at once.
 */
import { expect, isHydrated, test, waitForHydration } from "./fixtures";

const CHUNK_PATTERN = /\/_next\/static\/chunks\/.*\.js(\?.*)?$/;

test("a fold opened before hydration neither reports a mismatch nor loses the toggle", async ({
  page,
}) => {
  // Hold every route chunk so nothing can hydrate until we say so. Each one is
  // FETCHED first and its response held, rather than the request being parked:
  // under `next dev` a request held for seconds comes back 404 once the compiler
  // has moved on, which breaks the page instead of merely delaying it.
  let hydrationHeld = true;
  let letHydrationThrough = () => {};
  const gate = new Promise<void>((resolve) => {
    letHydrationThrough = resolve;
  });
  await page.route(CHUNK_PATTERN, async (route) => {
    if (!hydrationHeld) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });

  // `commit`, not `load`: with the scripts held, the load event never fires.
  await page.goto("/ajustes", { waitUntil: "commit" });

  const fold = page.locator("section.dangerZone details.confirmDelete");
  await expect(fold).toBeVisible();
  expect(
    await isHydrated(fold),
    "React hydrated the fold despite the held chunks — this journey would then " +
      "assert nothing, so fail loudly instead of passing vacuously",
  ).toBe(false);

  // The person opens the fold while React is still on its way.
  await fold.locator("summary").click();
  await expect(fold).toHaveJSProperty("open", true);

  // Hydration now lands on a DOM that already diverges from the server HTML. The
  // route handler stays installed (unrouting it mid-flight abandons the responses
  // it is still holding) and simply stops holding.
  hydrationHeld = false;
  letHydrationThrough();
  await waitForHydration(fold);

  // React must leave the person's toggle alone — and say nothing about it: the
  // console guard in `fixtures.ts` fails this journey on any hydration error.
  await expect(fold).toHaveJSProperty("open", true);
});
