import { describe, expect, test } from "vitest";
import { createFxRateSnapshot, createMoneyConverter } from "./fx";
import { calculateNetWorth } from "./net-worth";
import { projectPortfolio } from "./portfolio-projection";
import { createManualAsset, createWorkspace } from "./workspace-types";

const ASOF = "2026-07-13";

function euroWorkspace() {
  return createWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
}

function usdConverter() {
  return {
    asOf: ASOF,
    converter: createMoneyConverter(
      createFxRateSnapshot({ USD: [{ dateKey: ASOF, eurPerUnit: 0.9 }] }),
    ),
  };
}

/**
 * Two holdings — one EUR, one USD — in an EUR-base workspace. The USD one is the
 * lever: convertible (a rate exists) → counted; unconvertible (no converter, or a
 * missing rate) → excluded and reported, never silently summed as EUR.
 */
function mixedAssets(workspace: ReturnType<typeof euroWorkspace>) {
  const eur = createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 100_000,
    id: "asset_eur",
    liquidityTier: "cash",
    name: "Cuenta EUR",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });
  const usd = createManualAsset(workspace, {
    currency: "USD",
    currentValueMinor: 100_000,
    id: "asset_usd",
    liquidityTier: "cash",
    name: "Cuenta USD",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });
  return { eur, usd };
}

describe("calculateNetWorth with mixed currencies (#1065)", () => {
  test("converts a non-EUR holding when a rate is available", () => {
    const workspace = euroWorkspace();
    const { eur, usd } = mixedAssets(workspace);

    const summary = calculateNetWorth({
      assets: [eur, usd],
      fx: usdConverter(),
      scopeId: "household",
      workspace,
    });

    // 1000.00 EUR + (1000.00 USD × 0.90) = 1000.00 + 900.00 = 1900.00 EUR.
    expect(summary.grossAssets.amountMinor).toBe(190_000);
    expect(summary.fxExcluded).toEqual([]);
  });

  test("EXCLUDES a non-EUR holding and reports it when no converter is provided", () => {
    const workspace = euroWorkspace();
    const { eur, usd } = mixedAssets(workspace);

    const summary = calculateNetWorth({
      assets: [eur, usd],
      scopeId: "household",
      workspace,
    });

    // Only the EUR holding counts — the USD one is NOT summed as if it were EUR.
    expect(summary.grossAssets.amountMinor).toBe(100_000);
    expect(summary.fxExcluded).toEqual([
      {
        holdingId: "asset_usd",
        name: "Cuenta USD",
        original: { amountMinor: 100_000, currency: "USD" },
        reason: "missing-rate",
      },
    ]);
  });

  test("EXCLUDES a non-EUR holding when the converter has no rate for it", () => {
    const workspace = euroWorkspace();
    const { eur, usd } = mixedAssets(workspace);

    const summary = calculateNetWorth({
      assets: [eur, usd],
      // A converter that only knows GBP → USD stays unconvertible.
      fx: {
        asOf: ASOF,
        converter: createMoneyConverter(
          createFxRateSnapshot({ GBP: [{ dateKey: ASOF, eurPerUnit: 1.15 }] }),
        ),
      },
      scopeId: "household",
      workspace,
    });

    expect(summary.grossAssets.amountMinor).toBe(100_000);
    expect(summary.fxExcluded.map((h) => h.holdingId)).toEqual(["asset_usd"]);
  });
});

describe("reconciliation invariant holds under FX exclusion (#1065)", () => {
  const cases: Array<{ label: string; fx: ReturnType<typeof usdConverter> | undefined }> =
    [
      { fx: usdConverter(), label: "with a converter (USD converted)" },
      { fx: undefined, label: "without a converter (USD excluded)" },
    ];

  for (const { label, fx } of cases) {
    test(`sum(projection asset rows) === netWorth.grossAssets ${label}`, () => {
      const workspace = euroWorkspace();
      const { eur, usd } = mixedAssets(workspace);
      const scope = { id: "household", label: "Hogar", type: "household" as const };

      const summary = calculateNetWorth({
        assets: [eur, usd],
        ...(fx ? { fx } : {}),
        scopeId: "household",
        workspace,
      });
      const projection = projectPortfolio({
        assets: [eur, usd],
        ...(fx ? { fx } : {}),
        liabilities: [],
        scope,
        workspace,
      });

      const rowsSum = projection.sections[0].rows.reduce(
        (total, row) => total + row.valueMinor,
        0,
      );
      expect(rowsSum).toBe(summary.grossAssets.amountMinor);
      expect(projection.fxExcluded.map((h) => h.holdingId)).toEqual(
        summary.fxExcluded.map((h) => h.holdingId),
      );
    });
  }
});
