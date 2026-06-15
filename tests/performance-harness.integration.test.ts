/**
 * Performance harness — integration test (issue #200).
 *
 * A reproducible, agent-runnable harness that seeds a representative worthline
 * workspace (tests/performance-harness-seeds.ts) and measures the hot paths the
 * performance audit flagged:
 *   1. Dashboard load     — the multi-scope capture loop + frozen-row reads that
 *                           apps/web/app/load-dashboard.ts runs on every request.
 *   2. Frozen holding reads — readSnapshotHoldings over the full history and a
 *                           recent window (the composition chart + drilldown feed).
 *   3. Position projection  — readPositions deriving units/cost/PnL from operations.
 *   4. Historical snapshot ripple — a backdated operation, a housing valuation
 *                           change, and an early debt repayment, each recalculating
 *                           a band of existing snapshots (ADR 0012).
 *
 * WHY THIS IS A TEST, NOT A BENCHMARK SCRIPT (#200):
 * The harness is deterministic and network-free — it uses the established
 * file-backed SQLite store and manual prices/valuations (no Numista, no Yahoo,
 * no ECB), so the SAME work runs every time and a regression shows as a timing
 * change rather than seed drift. The assertions are CONSERVATIVE wall-clock
 * ceilings (≈ 4–8× the local median) chosen to stay green under CI load, plus a
 * structural baseline snapshot so the set of measured operations cannot silently
 * drift. The ceilings catch order-of-magnitude regressions (the audit's real
 * concern) without being flaky.
 *
 * HOW TO UPDATE THE THRESHOLDS INTENTIONALLY:
 * After an intentional optimization (#201/#203/#205/#206/#207/#208 build on this
 * harness) the ceilings below can be LOWERED to lock in the gain — edit the
 * THRESHOLDS_MS map and note the change in the PR. The structural baseline is a
 * vitest snapshot: regenerate it with `npm test -- -u` when the set of measured
 * operations changes on purpose. Never raise a ceiling to silence a regression
 * without understanding why it slowed down.
 */
import { afterEach, describe, expect, test } from "vitest";

import type { InvestmentCaptureDetail } from "@worthline/domain";
import { captureSnapshotForScope, listScopeOptions } from "@worthline/domain";

import { cleanupTempDirs, createFileBackedStore } from "./helpers";
import {
  SEED_SCOPE_IDS,
  SEED_TODAY,
  seedPerformanceWorkspace,
} from "./performance-harness-seeds";

afterEach(cleanupTempDirs);

/**
 * Conservative wall-clock ceilings in milliseconds. These are deliberately
 * loose (several × the observed local median) so CI variance never makes the
 * harness flaky — it exists to catch order-of-magnitude regressions, not to
 * benchmark precisely. Lower them after an intentional optimization to lock the
 * gain in (and say so in the PR).
 */
const THRESHOLDS_MS = {
  dashboardLoad: 3_000,
  debtRipple: 2_500,
  fullHistoryRead: 250,
  operationRipple: 4_000,
  positionProjection: 250,
  valuationRipple: 4_000,
  windowedHistoryRead: 250,
} as const;

type Measurement = {
  name: keyof typeof THRESHOLDS_MS;
  durationMs: number;
  touched: number;
};

/** Run `fn`, recording its wall-clock duration and how many rows/snapshots it touched. */
function measure(
  name: keyof typeof THRESHOLDS_MS,
  touchedOf: (result: unknown) => number,
  fn: () => unknown,
): Measurement {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { durationMs, name, touched: touchedOf(result) };
}

/**
 * The dashboard load path's multi-scope capture loop, mirrored from
 * apps/web/app/load-dashboard.ts (no price refresh — that is the network seam,
 * stubbed out of the harness by construction).
 */
function runCaptureLoop(store: ReturnType<typeof createFileBackedStore>): number {
  const workspace = store.workspace.readWorkspace()!;
  const assets = store.assets.readAssets();
  const liabilities = store.liabilities.readLiabilities();
  const scopes = listScopeOptions(workspace);

  const investmentDetails = new Map<string, InvestmentCaptureDetail>(
    store.snapshots.readPositions().map((position) => [
      position.assetId,
      {
        units: position.currentUnits,
        ...(position.currentPricePerUnit
          ? { unitPrice: position.currentPricePerUnit }
          : {}),
      },
    ]),
  );

  let saved = 0;
  for (const scope of scopes) {
    const capture = captureSnapshotForScope({
      assets,
      capturedAt: `${SEED_TODAY}T10:00:00.000Z`,
      existingSnapshots: store.snapshots.readSnapshots(scope.id),
      investmentDetails,
      liabilities,
      scope,
      workspace,
    });
    if (capture) {
      store.snapshots.saveSnapshot({
        holdings: capture.holdings,
        replace: capture.replace,
        snapshot: capture.snapshot,
      });
      saved++;
    }
  }
  return saved;
}

/**
 * Drive every measured hot path against a freshly seeded workspace and return
 * the measurements. Shared by all three tests so they measure identical work.
 */
function runHarness(): Measurement[] {
  const store = createFileBackedStore("worthline-perf-harness-");
  const seed = seedPerformanceWorkspace(store);

  const measurements: Measurement[] = [];

  // 1. Dashboard load — the multi-scope capture loop the web app runs per request.
  measurements.push(
    measure(
      "dashboardLoad",
      (r) => r as number,
      () => runCaptureLoop(store),
    ),
  );

  // 2. Frozen holding reads — full history, then the recent-window slice.
  measurements.push(
    measure(
      "fullHistoryRead",
      (r) => (r as unknown[]).length,
      () => store.snapshots.readSnapshotHoldings({ scopeId: "household" }),
    ),
  );
  measurements.push(
    measure(
      "windowedHistoryRead",
      (r) => (r as unknown[]).length,
      () =>
        store.snapshots.readSnapshotHoldings({
          from: "2026-04-01",
          scopeId: "household",
          to: SEED_TODAY,
        }),
    ),
  );

  // 3. Position projection — units/cost/PnL derived from the seeded operations.
  measurements.push(
    measure(
      "positionProjection",
      (r) => (r as unknown[]).length,
      () => store.snapshots.readPositions("household"),
    ),
  );

  // 4a. Operation ripple — a backdated buy recalculates the snapshots ≥ its date.
  const beforeOperationRipple = store.snapshots.readSnapshots("household").length;
  measurements.push(
    measure(
      "operationRipple",
      () => beforeOperationRipple,
      () => {
        store.operations.recordOperation({
          assetId: seed.rippleInvestmentId,
          currency: "EUR",
          executedAt: seed.rippleOperationDateKey,
          id: "perf_backdated_buy",
          kind: "buy",
          pricePerUnit: "55",
          units: "2",
        });
        store.rippleHistoricalSnapshotsForOperation({
          assetId: seed.rippleInvestmentId,
          mode: "record",
          operationDateKey: seed.rippleOperationDateKey,
          today: SEED_TODAY,
        });
      },
    ),
  );

  // 4b. Housing valuation ripple — a backdated appraisal recalculates snapshots ≥ its date.
  measurements.push(
    measure(
      "valuationRipple",
      () => beforeOperationRipple,
      () => {
        store.assets.addValuationAnchor({
          adjustsPriorCurve: true,
          assetId: seed.rippleHousingId,
          id: "perf_backdated_appraisal",
          valuationDate: seed.rippleValuationDateKey,
          valueMinor: 305_000_00,
        });
        store.rippleHistoricalSnapshotsForValuation({
          assetId: seed.rippleHousingId,
          fromDateKey: seed.rippleValuationDateKey,
          today: SEED_TODAY,
        });
      },
    ),
  );

  // 4c. Debt ripple — an early repayment recalculates the mortgage's snapshots ≥ its date.
  measurements.push(
    measure(
      "debtRipple",
      () => beforeOperationRipple,
      () => {
        store.liabilities.addEarlyRepayment({
          amountMinor: 3_000_00,
          id: "perf_extra_repayment",
          mode: "reduce-payment",
          planId: "plan_mortgage",
          repaymentDate: seed.rippleValuationDateKey,
        });
        store.rippleHistoricalSnapshotsForDebt({
          fromDateKey: seed.rippleValuationDateKey,
          kind: "amortizable-repayment",
          liabilityId: seed.rippleDebtId,
          today: SEED_TODAY,
        });
      },
    ),
  );

  store.close();
  return measurements;
}

describe("performance harness (integration, #200)", () => {
  test("seeds a representative workspace and exercises every hot path within conservative ceilings", () => {
    const measurements = runHarness();

    // The seed must actually produce a non-trivial history, else the harness
    // measures nothing meaningful and a regression would hide.
    const fullHistory = measurements.find((m) => m.name === "fullHistoryRead")!;
    expect(fullHistory.touched).toBeGreaterThan(100);
    const dashboard = measurements.find((m) => m.name === "dashboardLoad")!;
    expect(dashboard.touched).toBe(SEED_SCOPE_IDS.length);
    const positions = measurements.find((m) => m.name === "positionProjection")!;
    expect(positions.touched).toBe(3);

    // Every measured path stays under its conservative ceiling.
    for (const measurement of measurements) {
      expect(
        measurement.durationMs,
        `${measurement.name} took ${measurement.durationMs.toFixed(1)}ms (touched ${measurement.touched}), ceiling ${THRESHOLDS_MS[measurement.name]}ms`,
      ).toBeLessThan(THRESHOLDS_MS[measurement.name]);
    }
  });

  test("reports a timing breakdown for manual inspection", () => {
    const measurements = runHarness();

    const lines = [
      "",
      "Performance Harness Report (#200) — 3 scopes, seeded history",
      "──────────────────────────────────────────────────────────",
      ...measurements.map(
        (m) =>
          `  ${m.name.padEnd(22)} ${m.durationMs.toFixed(1).padStart(8)} ms   (touched ${m.touched}, ceiling ${THRESHOLDS_MS[m.name]} ms)`,
      ),
      "",
    ];
    // The timing report IS a deliverable of this harness (#200).
    console.log(lines.join("\n"));

    // The report only passes when every path is under its ceiling.
    for (const m of measurements) {
      expect(m.durationMs).toBeLessThan(THRESHOLDS_MS[m.name]);
    }
  });

  test("guards the set of measured hot paths via a structural baseline snapshot", () => {
    const measurements = runHarness();

    // A STRUCTURAL baseline — names + ceilings + touched counts, never the raw
    // timings (those vary with the host). This freezes WHAT is measured and the
    // seeded scale, so a future change to the harness/seed is a deliberate
    // snapshot update (`npm test -- -u`) rather than a silent drift.
    const baseline = measurements.map((m) => ({
      name: m.name,
      ceilingMs: THRESHOLDS_MS[m.name],
      touched: m.touched,
    }));
    expect(baseline).toMatchSnapshot();
  });
});
