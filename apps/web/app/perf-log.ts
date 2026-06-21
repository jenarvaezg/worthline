/**
 * Structured timing logs (#448). The store seam and the two pages that open a
 * store by hand bracket their store work with `perfStart()` / `perfEnd()`, which
 * emits one concise line per unit of work:
 *
 *   [perf] <label> dur=<ms>ms
 *
 * The line goes to stdout, so it lands in the Vercel runtime logs and is queryable
 * in the dashboard or via the MCP by searching `[perf]`. Vercel attributes each
 * line to its request's method + path, so it answers "where does this page/action
 * spend its time — the store round-trips or the render?" without a tracing backend.
 * Deliberately coarse (the cheap always-on signal chosen for #448, not full
 * OpenTelemetry spans).
 *
 * Silent under Vitest so unit/wiring tests that open stores don't spam output.
 */
const SILENT = Boolean(process.env.VITEST);

/** Start a timer. Returns an opaque start mark to hand to `perfEnd`. */
export function perfStart(): number {
  return SILENT ? 0 : performance.now();
}

/** Log `[perf] <label> dur=<ms>ms` for the work since `startedAt`. No-op in tests. */
export function perfEnd(label: string, startedAt: number): void {
  if (SILENT) return;
  console.log(`[perf] ${label} dur=${Math.round(performance.now() - startedAt)}ms`);
}
