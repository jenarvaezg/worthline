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
 * HOW TO UPDATE THE BUDGETS INTENTIONALLY (#203):
 * The conservative budgets, the documented large-workspace baseline, and the
 * rules for changing them on purpose live in docs/performance-budgets.md. In
 * short: after an intentional optimization (#201/#205/#206/#207/#208 build on
 * this harness) LOWER the relevant ceiling in THRESHOLDS_MS to lock the gain in
 * and say so in the PR; when the domain workload genuinely grows, re-baseline
 * SEED_DIMENSIONS (in performance-harness-seeds.ts) alongside the seed change and
 * regenerate the structural snapshot with `npm test -- -u`. Never raise a ceiling
 * to silence a regression without understanding why it slowed down.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import Database from "libsql";
import { captureSnapshotForScope, listScopeOptions } from "@worthline/domain";

import { cleanupTempDirs, createFileBackedStore } from "./helpers";
import {
  measureSeedDimensions,
  SEED_DIMENSIONS,
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
  windowedHistoryRead: 500,
} as const;
const HARNESS_TIMEOUT_MS = 20_000;

/**
 * The four hot paths the performance audit flagged (#203 AC: "Dashboard load,
 * snapshot holding reads, position reads, and historical snapshot ripple each
 * have a conservative threshold"), mapped to the THRESHOLDS_MS keys that budget
 * them. Every path here MUST have at least one conservative ceiling, and the
 * harness asserts that — so a future refactor that drops a measurement (and its
 * budget) fails loudly instead of quietly leaving an audit path unguarded.
 */
const BUDGETED_AUDIT_PATHS: Record<string, ReadonlyArray<keyof typeof THRESHOLDS_MS>> = {
  "dashboard load": ["dashboardLoad"],
  "historical snapshot ripple": ["operationRipple", "valuationRipple", "debtRipple"],
  "position reads": ["positionProjection"],
  "snapshot holding reads": ["fullHistoryRead", "windowedHistoryRead"],
};

type Measurement = {
  name: keyof typeof THRESHOLDS_MS;
  durationMs: number;
  touched: number;
};

/** Run `fn`, recording its wall-clock duration and how many rows/snapshots it touched. */
async function measure(
  name: keyof typeof THRESHOLDS_MS,
  touchedOf: (result: unknown) => number,
  fn: () => unknown,
): Promise<Measurement> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { durationMs, name, touched: touchedOf(result) };
}

/**
 * The dashboard load path's multi-scope capture loop, mirrored from
 * apps/web/app/load-dashboard.ts (no price refresh — that is the network seam,
 * stubbed out of the harness by construction).
 */
async function runCaptureLoop(
  store: Awaited<ReturnType<typeof createFileBackedStore>>,
): Promise<number> {
  const workspace = (await store.workspace.readWorkspace())!;
  const assets = await store.assets.readAssets();
  const liabilities = await store.liabilities.readLiabilities();
  const scopes = listScopeOptions(workspace);
  const selectedScope = scopes[0];

  // Mirror the production reuse seam (#208): one projection serves both the
  // unscoped capture details that freeze every scope's rows AND the selected
  // scope's positions, reading every investment operation once per load instead
  // of twice.
  const { details: investmentDetails } =
    await store.snapshots.readScopedPositionsWithDetails(selectedScope?.id);

  let saved = 0;
  for (const scope of scopes) {
    const capture = captureSnapshotForScope({
      assets,
      capturedAt: `${SEED_TODAY}T10:00:00.000Z`,
      existingSnapshots: await store.snapshots.readSnapshots(scope.id),
      investmentDetails,
      liabilities,
      scope,
      workspace,
    });
    if (capture) {
      await store.snapshots.saveSnapshot({
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
async function runHarness(): Promise<Measurement[]> {
  const store = await createFileBackedStore("worthline-perf-harness-");
  const seed = await seedPerformanceWorkspace(store);

  const measurements: Measurement[] = [];

  // 1. Dashboard load — the multi-scope capture loop the web app runs per request.
  measurements.push(
    await measure(
      "dashboardLoad",
      (r) => r as number,
      () => runCaptureLoop(store),
    ),
  );

  // 2. Frozen holding reads — full history, then the recent-window slice.
  measurements.push(
    await measure(
      "fullHistoryRead",
      (r) => (r as unknown[]).length,
      () => store.snapshots.readSnapshotHoldings({ scopeId: "household" }),
    ),
  );
  measurements.push(
    await measure(
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
    await measure(
      "positionProjection",
      (r) => (r as unknown[]).length,
      () => store.snapshots.readPositions("household"),
    ),
  );

  // 4a. Operation ripple — a backdated buy recalculates the snapshots ≥ its date.
  const beforeOperationRipple = (await store.snapshots.readSnapshots("household")).length;
  measurements.push(
    await measure(
      "operationRipple",
      () => beforeOperationRipple,
      async () => {
        await store.recordOperationAndRipple(
          {
            assetId: seed.rippleInvestmentId,
            currency: "EUR",
            executedAt: seed.rippleOperationDateKey,
            id: "perf_backdated_buy",
            kind: "buy",
            pricePerUnit: "55",
            units: "2",
          },
          { today: SEED_TODAY },
        );
      },
    ),
  );

  // 4b. Housing valuation ripple — a backdated appraisal recalculates snapshots ≥ its date.
  measurements.push(
    await measure(
      "valuationRipple",
      () => beforeOperationRipple,
      async () => {
        await store.addValuationAnchorAndRipple(
          {
            adjustsPriorCurve: true,
            assetId: seed.rippleHousingId,
            id: "perf_backdated_appraisal",
            valuationDate: seed.rippleValuationDateKey,
            valueMinor: 305_000_00,
          },
          { today: SEED_TODAY },
        );
      },
    ),
  );

  // 4c. Debt ripple — an early repayment recalculates the mortgage's snapshots ≥ its date.
  measurements.push(
    await measure(
      "debtRipple",
      () => beforeOperationRipple,
      async () => {
        await store.addEarlyRepaymentAndRipple(
          {
            amountMinor: 3_000_00,
            id: "perf_extra_repayment",
            mode: "reduce-payment",
            planId: "plan_mortgage",
            repaymentDate: seed.rippleValuationDateKey,
          },
          { liabilityId: seed.rippleDebtId, today: SEED_TODAY },
        );
      },
    ),
  );

  store.close();
  return measurements;
}

describe("performance harness (integration, #200)", () => {
  test(
    "seeds a representative workspace and exercises every hot path within conservative ceilings",
    async () => {
      const measurements = await runHarness();

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
    },
    HARNESS_TIMEOUT_MS,
  );

  test(
    "reports a timing breakdown for manual inspection",
    async () => {
      const measurements = await runHarness();

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
    },
    HARNESS_TIMEOUT_MS,
  );

  test(
    "guards the set of measured hot paths via a structural baseline snapshot",
    async () => {
      const measurements = await runHarness();

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
    },
    HARNESS_TIMEOUT_MS,
  );
});

describe("performance budgets (large-workspace baseline, #203)", () => {
  test("the seeded workspace matches the documented large-workspace baseline", async () => {
    // AC: the benchmark documents the seeded workspace dimensions used as the
    // large-workspace baseline. We assert the LIVE seed equals the recorded
    // SEED_DIMENSIONS so the budgets are always anchored to a known scale — a
    // seed change is a deliberate re-baseline, not a silent drift.
    const store = await createFileBackedStore("worthline-perf-budget-");
    await seedPerformanceWorkspace(store);
    const dimensions = await measureSeedDimensions(store);
    store.close();

    expect(dimensions).toEqual(SEED_DIMENSIONS);

    // Sanity floor: the baseline must stay genuinely "large" so the budgets
    // measure meaningful work. Hundreds of frozen holding rows is the property
    // the audit cared about; guard it explicitly rather than trusting the seed.
    expect(SEED_DIMENSIONS.householdHoldingRows).toBeGreaterThan(1_000);
    expect(SEED_DIMENSIONS.totalHoldingRows).toBeGreaterThan(2_000);
    expect(SEED_DIMENSIONS.totalSnapshots).toBeGreaterThan(200);
  });

  test("every audit-flagged hot path has a conservative budget", () => {
    // AC: dashboard load, snapshot holding reads, position reads, and historical
    // snapshot ripple each have a conservative threshold. We assert each named
    // path maps to at least one defined, positive ms ceiling so no audit path is
    // ever left unbudgeted by a future refactor.
    for (const [path, keys] of Object.entries(BUDGETED_AUDIT_PATHS)) {
      expect(keys.length, `${path} has no budget mapped`).toBeGreaterThan(0);
      for (const key of keys) {
        const ceiling = THRESHOLDS_MS[key];
        expect(ceiling, `${path} → ${key} ceiling`).toBeGreaterThan(0);
      }
    }

    // The mapping must cover exactly the four audit-flagged paths — no more, no
    // fewer — and collectively reference every measured threshold so a stray,
    // unbudgeted measurement cannot slip in.
    expect(Object.keys(BUDGETED_AUDIT_PATHS).sort()).toEqual([
      "dashboard load",
      "historical snapshot ripple",
      "position reads",
      "snapshot holding reads",
    ]);
    const budgetedKeys = new Set(Object.values(BUDGETED_AUDIT_PATHS).flat());
    expect([...budgetedKeys].sort()).toEqual(
      (Object.keys(THRESHOLDS_MS) as Array<keyof typeof THRESHOLDS_MS>).sort(),
    );
  });
});

/**
 * Read-shape regression (#208). Beyond the wall-clock ceilings (which are too
 * loose to catch a doubled read on this small-by-ms but operation-heavy seed),
 * this guards the actual WIN: a dashboard-style load over the large seeded
 * workspace (3 investments × 24 backdated operations) reads the operations table
 * exactly ONCE, not once per readPositions() call. Instruments libsql to
 * count full scans of asset_operations — Drizzle emits the full operation read as
 * `select ... from "asset_operations" order by ...` with no WHERE; the targeted
 * single-asset reads carry a `where`, so they are not counted.
 */
describe("dashboard load read shape — investment projection reuse (#208)", () => {
  const originalPrepare = Database.prototype.prepare;
  let fullOperationScans = 0;

  beforeEach(() => {
    fullOperationScans = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Database.prototype.prepare = function (this: any, sql: string, ...rest: any[]) {
      const normalized = sql.toLowerCase();
      if (
        normalized.includes('from "asset_operations"') &&
        !normalized.includes("where")
      ) {
        fullOperationScans += 1;
      }
      return originalPrepare.call(this, sql, ...rest);
    } as typeof Database.prototype.prepare;
  });

  afterEach(() => {
    Database.prototype.prepare = originalPrepare;
  });

  test("the dashboard capture loop reads the operations table once for the whole load", async () => {
    const store = await createFileBackedStore("worthline-perf-readshape-");
    await seedPerformanceWorkspace(store);

    const workspace = (await store.workspace.readWorkspace())!;
    const assets = await store.assets.readAssets();
    const liabilities = await store.liabilities.readLiabilities();
    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes[0]!;

    // Reset after seeding + the read-once assets/liabilities reads above, so only
    // the position-projection reuse seam below is measured.
    fullOperationScans = 0;

    const { details: investmentDetails, positions } =
      await store.snapshots.readScopedPositionsWithDetails(selectedScope.id);

    for (const scope of scopes) {
      const capture = captureSnapshotForScope({
        assets,
        capturedAt: `${SEED_TODAY}T10:00:00.000Z`,
        existingSnapshots: await store.snapshots.readSnapshots(scope.id),
        investmentDetails,
        liabilities,
        scope,
        workspace,
      });
      if (capture) {
        await store.snapshots.saveSnapshot({
          holdings: capture.holdings,
          replace: capture.replace,
          snapshot: capture.snapshot,
        });
      }
    }

    // Both the unscoped capture details and the selected scope's positions came
    // from a single context build — one full operations scan, not the two the
    // old unscoped-then-scoped readPositions() pair performed.
    expect(positions.length).toBeGreaterThan(0);
    expect(fullOperationScans).toBe(1);

    store.close();
  });

  test("a shared projection context reads the operations table once across assets + positions (#566)", async () => {
    const store = await createFileBackedStore("worthline-perf-dedup-");
    await seedPerformanceWorkspace(store);

    const workspace = (await store.workspace.readWorkspace())!;
    const selectedScope = listScopeOptions(workspace)[0]!;

    // load-dashboard builds the projection context ONCE and passes it to both
    // readAssets and readScopedPositionsWithDetails (dedup #566). The shared
    // context scans asset_operations exactly once; drop the context-passing and
    // each call rebuilds it, pushing the count above one and failing this test.
    fullOperationScans = 0;
    const projectionContext = await store.snapshots.buildProjectionContext();
    await store.assets.readAssets(projectionContext);
    const { positions } = await store.snapshots.readScopedPositionsWithDetails(
      selectedScope.id,
      projectionContext,
    );

    expect(positions.length).toBeGreaterThan(0);
    expect(fullOperationScans).toBe(1);

    store.close();
  });
});
