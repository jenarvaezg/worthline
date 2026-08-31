/**
 * `/admin/catalogo` page wiring + surface guardian (PRD #711 S4). Mocks the
 * admin guard and the reference-catalog read seam to prove the page composes
 * them, renders the master-detail workbench on the canonical PAPER primitives
 * (`.demoLanding` + `.section`), degrades explicitly when the catalog is
 * unavailable (#943), and propagates a rejected guard unchanged.
 */
import type {
  ExposureCatalogAvailability,
  GlobalExposureProfile,
} from "@worthline/domain";
import { notFound } from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@web/admin/guard-admin", () => ({ guardAdmin: vi.fn() }));
vi.mock("@web/read-exposure-catalog", () => ({
  readExposureCatalogFromControlPlane: vi.fn(),
}));

import { guardAdmin } from "@web/admin/guard-admin";
import { readExposureCatalogFromControlPlane } from "@web/read-exposure-catalog";

import AdminCatalogPage from "./page";

const UNCOVERED: GlobalExposureProfile = {
  identity: { kind: "provider", priceProvider: "yahoo", providerSymbol: "VWCE.DE" },
  displayName: "FTSE All-World",
  breakdowns: { geography: { us: "0.6" } },
  ter: "0.0022",
  trackedIndex: "FTSE All-World",
  hedgedToCurrency: null,
  // Una fila anterior a #1508: procedencia sin declarar, que es la verdad sobre ella.
  confidence: null,
  asOfDate: null,
  sources: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

const COVERED: GlobalExposureProfile = {
  identity: { kind: "isin", isin: "US9229087690" },
  displayName: "Total Market",
  breakdowns: {
    geography: { us: "1" },
    currency: { USD: "1" },
    assetClass: { equity: "1" },
  },
  ter: "0.0003",
  trackedIndex: "CRSP US Total",
  hedgedToCurrency: null,
  confidence: "alta",
  asOfDate: "2026-07-31",
  sources: "factsheet CRSP 31/07/2026",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-06-02T00:00:00Z",
};

const SECTORED: GlobalExposureProfile = {
  identity: { kind: "isin", isin: "IE00B4L5Y983" },
  displayName: "World Equity",
  breakdowns: {
    assetClass: { equity: "1" },
    sector: { information_technology: "0.3", utilities: "0.2", health_care: "0.1" },
  },
  ter: "0.002",
  trackedIndex: "MSCI World",
  hedgedToCurrency: null,
  confidence: "baja",
  asOfDate: "2024-04-30",
  sources: "ficha mensual de la gestora",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-06-03T00:00:00Z",
};

function available(profiles: GlobalExposureProfile[]): ExposureCatalogAvailability {
  return { status: "available", profiles };
}

function renderPage(searchParams: Record<string, string> = {}) {
  return AdminCatalogPage({ searchParams: Promise.resolve(searchParams) });
}

describe("AdminCatalogPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardAdmin).mockResolvedValue({ email: "admin@example.com" });
  });

  test("renders the master-detail workbench on paper with the triage markers", async () => {
    vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue(
      available([UNCOVERED, COVERED]),
    );

    const html = renderToStaticMarkup(await renderPage());

    expect(html).toContain('class="demoLanding catalogAdmin"');
    expect(html).toContain("catalogWorkbench");
    expect(html).toContain("yahoo · VWCE.DE");
    expect(html).toContain("US9229087690");
    // The under-declared profile carries the gold «Aviso» marker; the fully
    // declared one does not.
    expect(html).toContain('class="catalogAviso"');
    expect(html).toContain("1 por categorizar");
  });

  test("degrades explicitly when the catalog is not configured (never a blank table)", async () => {
    vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue({
      status: "unavailable",
      reason: "not_configured",
    });

    const html = renderToStaticMarkup(await renderPage());

    expect(html).toContain("Catálogo no disponible");
    expect(html).toContain("WORTHLINE_CONTROL_PLANE_DB_URL");
    expect(html).not.toContain("catalogWorkbench");
  });

  test("degrades explicitly on a read failure", async () => {
    vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue({
      status: "unavailable",
      reason: "read_failed",
    });

    const html = renderToStaticMarkup(await renderPage());

    expect(html).toContain("No se pudo leer el catálogo");
    expect(html).not.toContain("catalogWorkbench");
  });

  test("opens the edit panel for a deep-linked profile with read-only identity", async () => {
    vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue(
      available([UNCOVERED, COVERED]),
    );

    const html = renderToStaticMarkup(await renderPage({ perfil: "US9229087690" }));

    // The detail panel shows the update form (identity fixed → "Guardar cambios").
    expect(html).toContain("Guardar cambios");
    expect(html).toContain("Rekey (cambiar identidad)");
    expect(html).toContain("Sin región");
    expect(html).toContain("Sin divisa");
  });

  test("edits the sector vector as % of equity with a derived defensive lens (S4)", async () => {
    vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue(
      available([SECTORED]),
    );

    const html = renderToStaticMarkup(await renderPage({ perfil: "IE00B4L5Y983" }));

    // The sector fieldset is present, titled "% de la renta variable".
    expect(html).toContain("Sector · de la renta variable");
    // The stored sector weights are pre-filled into the controlled inputs.
    expect(html).toContain('value="0.3"');
    // The three canonically defensive sectors carry the non-editable marker.
    expect((html.match(/catalogDefensiveMark/g) ?? []).length).toBe(3);
    // The derived defensive/cyclical lens renders as chips with the computed
    // split: utilities 0.2 + health_care 0.1 = 30% defensive, IT 0.3 = 30%
    // cyclical. Asserting the values (not just the labels) locks the derivation.
    expect(html).toContain("Defensivo");
    expect(html).toContain("Cíclico");
    expect((html.match(/30%/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("shows each vector's provenance and counts what is not worth believing (#1508)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T09:00:00Z"));
    try {
      vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue(
        available([UNCOVERED, COVERED, SECTORED]),
      );

      const html = renderToStaticMarkup(await renderPage());

      // The two new columns, and the honest reading of an undeclared provenance.
      expect(html).toContain("Confianza");
      expect(html).toContain("Corte");
      expect(html).toContain("sin declarar");
      // A cut-off date is read out loud, and the verified one is not marked.
      expect(html).toContain("30/04/2024");
      expect(html).toContain("31/07/2026");
      // Both triage lenses are reachable from the filter, and each one SAYS that
      // it folds the undeclared rows in — never asserting «de confianza baja»
      // about a row that merely lacks a declaration.
      expect(html).toContain("Baja o sin declarar");
      expect(html).toContain("Corte antiguo o sin fecha");
      expect(html).toContain("2 de confianza baja o sin declarar");
      expect(html).toContain("2 con corte de más de 12 meses o sin fecha");
      // The gold mark is for a DECLARED problem; an absence reads muted.
      expect(html).toContain(
        '<span class="catalogAviso" title="Confianza baja: el vector lee el mandato del fondo, no su cartera">baja</span>',
      );
      expect(html).toContain('<span class="catalogAvisoNone">sin declarar</span>');
      // And the two columns can order the register on their own.
      expect(html).toContain("Ordenar por confianza");
      expect(html).toContain("Ordenar por antigüedad del corte");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a deep-linked «corte antiguo» filter lists only the aged vectors (#1508)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T09:00:00Z"));
    try {
      vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue(
        available([UNCOVERED, COVERED, SECTORED]),
      );

      const html = renderToStaticMarkup(await renderPage({ filtro: "corte-antiguo" }));

      expect(html).toContain("yahoo · VWCE.DE");
      expect(html).toContain("IE00B4L5Y983");
      // The verified, freshly-dated profile is not in the list.
      expect(html).not.toContain("US9229087690");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a deep-linked order reads the whole set, dropping nothing (#1508)", async () => {
    vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue(
      available([UNCOVERED, COVERED, SECTORED]),
    );

    const html = renderToStaticMarkup(await renderPage({ orden: "confianza" }));

    // Ordering is not filtering: the verified profile is still on the list…
    expect(html).toContain("US9229087690");
    // …and the least-trustworthy row comes first (baja → sin declarar → alta).
    const order = ["IE00B4L5Y983", "yahoo · VWCE.DE", "US9229087690"].map((identity) =>
      html.indexOf(identity),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The active order is announced, not just arrowed.
    expect(html).toContain('aria-sort="ascending"');
  });

  test("the edit panel carries the stored provenance into its own fieldset (#1508)", async () => {
    vi.mocked(readExposureCatalogFromControlPlane).mockResolvedValue(
      available([SECTORED]),
    );

    const html = renderToStaticMarkup(await renderPage({ perfil: "IE00B4L5Y983" }));

    expect(html).toContain("Procedencia");
    expect(html).toContain("Fecha de corte de los datos");
    expect(html).toContain('value="2024-04-30"');
    expect(html).toContain("ficha mensual de la gestora");
    // The three levels are said out loud, not filed as codes.
    expect(html).toContain("baja · lectura del mandato, no de la cartera");
  });

  test("propagates guardAdmin's notFound() unchanged for a non-admin request", async () => {
    vi.mocked(guardAdmin).mockImplementation(async () => notFound());

    await expect(renderPage()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(readExposureCatalogFromControlPlane).not.toHaveBeenCalled();
  });
});
