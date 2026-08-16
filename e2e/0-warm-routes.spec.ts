/**
 * Journey 0: every route answers before the journeys start (#1270).
 *
 * The single-digit name is load-bearing. Playwright runs files in path order and
 * `-` sorts below `0`, so `00-route-migration.spec.ts` runs before anything called
 * `00-warm-routes` — which is exactly how a warm-up that warmed nothing nearly
 * shipped. `bunx playwright test --list` is the check; this file must be line one.
 *
 * `next dev` compiles a route the first time it is requested, and Turbopack's
 * dev filesystem cache means that cost is paid once per machine — but the run
 * that pays it is a run where a `page.goto` can sit for 8–14 s (measured on a
 * cold `.next`: `/login` 13.8 s, `/objetivos` 12.3 s, `/patrimonio` 10.5 s). That
 * is what made journeys 40, 43, 45 and 46 red on a fresh checkout and green on
 * every later run (#1270).
 *
 * The answer is not a wider budget — the assertions inside the journeys are about
 * the product, and a 30 s ceiling would just make a hang take 30 s to report.
 * It is to pay the compile HERE, once, where nothing is being asserted about
 * timing. With a warm cache this whole file costs about a second; with a cold one
 * it absorbs the compile that would otherwise land mid-journey.
 *
 * It earns its place as a test too: if a route 500s, this says so in one line
 * before ninety journeys fail in ninety different ways.
 */
import { expect, test } from "./fixtures";

/** Routes the suite navigates to often enough that their first compile shows up. */
const ROUTES = [
  "/",
  "/app",
  "/patrimonio",
  "/patrimonio/anadir",
  "/patrimonio/anadir/avanzado",
  "/historico",
  "/objetivos",
  "/ajustes",
  "/ajustes/conexiones",
  "/login",
] as const;

test("every workspace route answers, with its first compile paid up front", async ({
  request,
}) => {
  // CI serves a precompiled build, so there is nothing to warm there. Keep it as a
  // reachability check rather than skipping: it costs milliseconds against
  // `next start` and still catches a route that cannot render at all.
  //
  // The ceiling is the cold compile plus room, not a latency budget: the slowest
  // measured first compile was 13.8 s, and this must not become the place where a
  // slow route hides. The journeys keep their own 15 s navigation budget, so a route
  // that stays slow after warming still shows up there.
  for (const route of ROUTES) {
    const response = await request.get(route, { timeout: 45_000 });
    expect(response.status(), `${route} must answer`).toBeLessThan(400);
  }
});
