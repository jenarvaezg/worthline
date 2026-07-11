import type { DataQualitySignal, WarningOverride } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import { HERO_HEALTH_MAX_ALERTS, selectHeroHealth } from "./hero-data-health";

/** Build a signal with sensible defaults; override per-case. */
function signal(overrides: Partial<DataQualitySignal>): DataQualitySignal {
  const category = overrides.category ?? "warning";
  const code = overrides.code ?? "ZERO_VALUE_ASSET";
  const affectedId = overrides.affected?.id ?? "h1";
  return {
    affected: { id: affectedId, label: "Cuenta", object: "holding" },
    category,
    code,
    fixable: true,
    label: "algo pasa",
    naturalKey: `${category}:${code}:${affectedId}`,
    severity: "medium",
    ...overrides,
  };
}

describe("selectHeroHealth", () => {
  it("renders nothing when there are no signals (clean)", () => {
    const view = selectHeroHealth([], []);
    expect(view.impact).toBe("clean");
    expect(view.alerts).toHaveLength(0);
    expect(view.hiddenCount).toBe(0);
  });

  it("is an error when a high-severity signal is present", () => {
    const view = selectHeroHealth(
      [
        signal({
          affected: { id: "h1", label: "Fondo", object: "holding" },
          category: "price_freshness",
          code: "FAILED_PRICE",
          fixable: false,
          severity: "high",
        }),
      ],
      [],
    );
    expect(view.impact).toBe("error");
    expect(view.alerts).toHaveLength(1);
    expect(view.alerts[0]?.href).toBe("/patrimonio/h1");
  });

  it("is a warning when only medium/low signals are present", () => {
    const view = selectHeroHealth(
      [
        signal({
          category: "manual_value_freshness",
          code: "STALE_MANUAL_VALUE",
          severity: "medium",
        }),
      ],
      [],
    );
    expect(view.impact).toBe("warning");
    expect(view.alerts).toHaveLength(1);
  });

  it("shows only the highest-severity tier, not lower ones", () => {
    const high = signal({
      affected: { id: "s1", label: "Fuente", object: "connected_source" },
      category: "source_freshness",
      code: "FAILED_SOURCE_SYNC",
      fixable: false,
      severity: "high",
    });
    const medium = signal({
      category: "manual_value_freshness",
      code: "STALE_MANUAL_VALUE",
      severity: "medium",
    });
    const view = selectHeroHealth([medium, high], []);
    expect(view.impact).toBe("error");
    expect(view.alerts.map((a) => a.severity)).toEqual(["high"]);
  });

  it("orders shown alerts by the engine's stable ordering", () => {
    // Same severity, different categories: warning sorts before manual_value_freshness.
    const stale = signal({
      affected: { id: "h2", label: "B", object: "holding" },
      category: "manual_value_freshness",
      code: "STALE_MANUAL_VALUE",
      severity: "medium",
    });
    const warn = signal({
      affected: { id: "h1", label: "A", object: "holding" },
      category: "warning",
      code: "MISSING_PROVIDER_SYMBOL",
      severity: "medium",
    });
    const view = selectHeroHealth([stale, warn], []);
    expect(view.alerts.map((a) => a.key)).toEqual([warn.naturalKey, stale.naturalKey]);
  });

  it("suppresses an overrideable signal that has been acknowledged", () => {
    const overridden: WarningOverride = { code: "STALE_MANUAL_VALUE", entityId: "h1" };
    const view = selectHeroHealth(
      [
        signal({
          affected: { id: "h1", label: "Cuenta", object: "holding" },
          category: "manual_value_freshness",
          code: "STALE_MANUAL_VALUE",
          severity: "medium",
        }),
      ],
      [overridden],
    );
    expect(view.impact).toBe("clean");
    expect(view.alerts).toHaveLength(0);
  });

  it("does not suppress a non-overrideable signal even if an override matches its id", () => {
    // FAILED_PRICE is fixable-by-action, never overrideable.
    const view = selectHeroHealth(
      [
        signal({
          affected: { id: "h1", label: "Fondo", object: "holding" },
          category: "price_freshness",
          code: "FAILED_PRICE",
          fixable: false,
          severity: "high",
        }),
      ],
      [{ code: "FAILED_PRICE", entityId: "h1" }],
    );
    expect(view.impact).toBe("error");
    expect(view.alerts).toHaveLength(1);
  });

  it("caps the number of shown alerts and reports the overflow count", () => {
    const many = Array.from({ length: HERO_HEALTH_MAX_ALERTS + 2 }, (_, i) =>
      signal({
        affected: { id: `h${i}`, label: `Fondo ${i}`, object: "holding" },
        category: "price_freshness",
        code: "FAILED_PRICE",
        fixable: false,
        severity: "high",
      }),
    );
    const view = selectHeroHealth(many, []);
    expect(view.alerts).toHaveLength(HERO_HEALTH_MAX_ALERTS);
    expect(view.hiddenCount).toBe(2);
  });

  it("maps each figure-bearing category to its fix surface", () => {
    const cases: Array<[Partial<DataQualitySignal>, string | undefined]> = [
      [
        {
          category: "warning",
          code: "ZERO_VALUE_ASSET",
          affected: { id: "h1", label: "A", object: "holding" },
        },
        "/patrimonio/h1/editar",
      ],
      [
        {
          category: "manual_value_freshness",
          code: "STALE_MANUAL_VALUE",
          affected: { id: "h1", label: "A", object: "holding" },
        },
        "/patrimonio/actualizar",
      ],
      [
        {
          category: "price_freshness",
          code: "STALE_PRICE",
          severity: "medium",
          affected: { id: "h1", label: "A", object: "holding" },
        },
        "/patrimonio/h1",
      ],
      [
        {
          category: "source_freshness",
          code: "STALE_SOURCE_SYNC",
          severity: "medium",
          affected: { id: "s1", label: "S", object: "connected_source" },
        },
        "/ajustes",
      ],
      [
        {
          category: "missing_configuration",
          code: "MISSING_DEBT_MODEL",
          affected: { id: "h9", label: "Hipoteca", object: "holding" },
        },
        "/patrimonio/h9/editar",
      ],
      [
        {
          category: "projection_gap",
          code: "UNVALUED_POSITION",
          affected: { id: "s2", label: "S2", object: "connected_source" },
        },
        "/ajustes",
      ],
    ];
    for (const [partial, expectedHref] of cases) {
      const view = selectHeroHealth([signal(partial)], []);
      expect(view.alerts[0]?.href, `${partial.code}`).toBe(expectedHref);
    }
  });

  it("does not surface signals that don't bear on today's figure", () => {
    // Missing FIRE config (projections) and history coverage (the chart) stay in
    // the shared inventory but never headline the hero's trust-in-today's-figure.
    const nonFigure = [
      signal({
        category: "missing_configuration",
        code: "MISSING_FIRE_CONFIG",
        affected: { id: "sc1", label: "Hogar", object: "scope" },
      }),
      signal({
        category: "history_coverage",
        code: "NO_SNAPSHOTS",
        affected: { id: "sc1", label: "Hogar", object: "scope" },
      }),
      signal({
        category: "history_coverage",
        code: "SPARSE_SNAPSHOTS",
        severity: "low",
        affected: { id: "sc1", label: "Hogar", object: "scope" },
      }),
    ];
    const view = selectHeroHealth(nonFigure, []);
    expect(view.impact).toBe("clean");
    expect(view.alerts).toHaveLength(0);
  });
});
