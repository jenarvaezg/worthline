import type { DataQualitySignal, WarningOverride } from "@worthline/domain";
import { describe, expect, it } from "vitest";
import { HERO_HEALTH_MAX_ALERTS, selectHeroHealth } from "./hero-data-health";
import { holdingPublicIdIndex, managedPortfolioPublicIdIndex } from "./holding-route";

/**
 * The public-id registry the fix links are built from (#1318). Every `h*` id the
 * fixtures use is registered; `s*` (connected sources) and `sc*` (scopes) are
 * not holdings and link elsewhere.
 */
const publicIds = holdingPublicIdIndex(
  Array.from({ length: 12 }, (_, i) => ({
    entityId: `h${i}`,
    entityType: "holding" as const,
    publicId: `wl_hld_h${i}`,
  })),
);

/** The carteras gestionadas registry — `p1` is the only registered one (#1550). */
const portfolioPublicIds = managedPortfolioPublicIdIndex([
  { entityId: "p1", entityType: "managed_portfolio" as const, publicId: "wl_prt_p1" },
]);

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
    const view = selectHeroHealth([], [], publicIds, portfolioPublicIds);
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
      publicIds,
      portfolioPublicIds,
    );
    expect(view.impact).toBe("error");
    expect(view.alerts).toHaveLength(1);
    expect(view.alerts[0]?.href).toBe("/patrimonio/wl_hld_h1/editar");
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
      publicIds,
      portfolioPublicIds,
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
    const view = selectHeroHealth([medium, high], [], publicIds, portfolioPublicIds);
    expect(view.impact).toBe("error");
    expect(view.alerts.map((a) => a.severity)).toEqual(["high"]);
  });

  it("headlines a connection whose sync keeps failing, linking to the page (#1226)", () => {
    // El criterio de aceptación de S4: la señal no se queda en el inventario del
    // agente. Una cifra congelada porque el sync lleva días fallando compromete la
    // confianza en el número de hoy tanto como un precio roto, así que pasa el
    // filtro «¿afecta a la cifra de hoy?» y aterriza donde se repara.
    const view = selectHeroHealth(
      [
        signal({
          affected: { id: "s1", label: "Binance", object: "connected_source" },
          category: "source_freshness",
          code: "PERSISTENT_SYNC_FAILURE",
          fixable: false,
          label: 'Las últimas 3 sincronizaciones de "Binance" fallaron.',
          severity: "high",
        }),
      ],
      [],
      publicIds,
      portfolioPublicIds,
    );

    expect(view.impact).toBe("error");
    expect(view.alerts).toHaveLength(1);
    expect(view.alerts[0]?.href).toBe("/ajustes/conexiones");
    expect(view.alerts[0]?.affectedLabel).toBe("Binance");
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
    const view = selectHeroHealth([stale, warn], [], publicIds, portfolioPublicIds);
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
      publicIds,
      portfolioPublicIds,
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
      publicIds,
      portfolioPublicIds,
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
    const view = selectHeroHealth(many, [], publicIds, portfolioPublicIds);
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
        "/patrimonio/wl_hld_h1/editar",
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
        "/patrimonio/wl_hld_h1/editar",
      ],
      [
        {
          category: "source_freshness",
          code: "STALE_SOURCE_SYNC",
          severity: "medium",
          affected: { id: "s1", label: "S", object: "connected_source" },
        },
        "/ajustes/conexiones",
      ],
      [
        {
          category: "missing_configuration",
          code: "MISSING_DEBT_MODEL",
          affected: { id: "h9", label: "Hipoteca", object: "holding" },
        },
        "/patrimonio/wl_hld_h9/editar",
      ],
      [
        {
          category: "projection_gap",
          code: "UNVALUED_POSITION",
          affected: { id: "s2", label: "S2", object: "connected_source" },
        },
        "/ajustes/conexiones",
      ],
      [
        // La ficha de la cartera (#1550): es donde viven la composición, el
        // efectivo y el propio saldo declarado, o sea todo lo que el careo
        // pone en duda.
        {
          category: "portfolio_reconciliation",
          code: "PORTFOLIO_DECLARED_VS_DERIVED",
          severity: "medium",
          affected: { id: "p1", label: "Metal", object: "managed_portfolio" },
        },
        "/patrimonio/carteras/wl_prt_p1",
      ],
      [
        // Una cartera sin fila en el registro no enlaza a un id que el router ya
        // no acepta: el aviso se pinta como texto.
        {
          category: "portfolio_reconciliation",
          code: "PORTFOLIO_DECLARED_VS_DERIVED",
          severity: "medium",
          affected: { id: "p2", label: "Otra", object: "managed_portfolio" },
        },
        undefined,
      ],
      [
        // Not the ficha (#1365): a trashed holding has none, and both repairs —
        // restore then record the sale, or confirm the borrado — live on the
        // Papelera at the foot of the board.
        {
          category: "trashed_balance",
          code: "TRASHED_WITH_BALANCE",
          affected: { id: "h1", label: "Fondo", object: "holding" },
        },
        "/patrimonio?abrir=papelera#papelera",
      ],
    ];
    for (const [partial, expectedHref] of cases) {
      const view = selectHeroHealth([signal(partial)], [], publicIds, portfolioPublicIds);
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
      // A missing ISIN (#1489) bites the NEXT statement, never today's price: the
      // holding is valued through its provider symbol like any other.
      signal({
        category: "missing_configuration",
        code: "MISSING_INVESTMENT_ISIN",
        severity: "low",
        affected: { id: "h1", label: "Fondo", object: "holding" },
      }),
    ];
    const view = selectHeroHealth(nonFigure, [], publicIds, portfolioPublicIds);
    expect(view.impact).toBe("clean");
    expect(view.alerts).toHaveLength(0);
  });
});
