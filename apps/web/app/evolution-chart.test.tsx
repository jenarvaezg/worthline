/**
 * SSR-render guard for the evolution chart (zero tolerance for React
 * warnings): React treats `console.error` as its warning channel, and a
 * warning here (e.g. a `<title>` whose children are an array — the source of
 * a real hydration mismatch on the home) must fail the suite, not scroll by
 * in the dev server logs.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { NetWorthSnapshot } from "@worthline/domain";

import EvolutionChart from "./evolution-chart";

function snapshot(input: {
  id: string;
  dateKey: string;
  valueMinor: number;
}): NetWorthSnapshot {
  const money = { amountMinor: input.valueMinor, currency: "EUR" } as const;

  return {
    capturedAt: `${input.dateKey}T12:00:00.000Z`,
    dateKey: input.dateKey,
    debts: { ...money, amountMinor: 0 },
    grossAssets: money,
    housingEquity: { ...money, amountMinor: 0 },
    id: input.id,
    isMonthlyClose: false,
    liquidNetWorth: money,
    monthKey: input.dateKey.slice(0, 7),
    scopeId: "scope_all",
    scopeLabel: "Hogar",
    totalNetWorth: money,
    warnings: [],
  };
}

const SNAPSHOTS = [
  snapshot({ dateKey: "2026-05-30", id: "s1", valueMinor: 100_000_00 }),
  snapshot({ dateKey: "2026-05-31", id: "s2", valueMinor: 101_000_00 }),
  snapshot({ dateKey: "2026-06-09", id: "s3", valueMinor: 103_000_00 }),
  snapshot({ dateKey: "2026-06-10", id: "s4", valueMinor: 102_000_00 }),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EvolutionChart — SSR renders without React warnings", () => {
  test("a multi-snapshot chart with monthly-close markers emits zero console.error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const markup = renderToStaticMarkup(
      <EvolutionChart framing="total" snapshots={SNAPSHOTS} />,
    );

    // Sanity: the markers actually rendered (the warning-prone path).
    expect(markup).toContain("evolutionMarker");
    expect(markup).toContain("<title>");

    expect(consoleError.mock.calls).toEqual([]);
  });

  test("marker titles render as a single text node: date · value", () => {
    const markup = renderToStaticMarkup(
      <EvolutionChart framing="total" snapshots={SNAPSHOTS} />,
    );

    const titles = [...markup.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);

    expect(titles.length).toBeGreaterThan(0);
    // The monthly close of May is its last snapshot.
    expect(titles.some((t) => t!.startsWith("2026-05-31 ·"))).toBe(true);
  });
});
