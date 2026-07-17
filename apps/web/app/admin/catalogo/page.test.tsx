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

  test("propagates guardAdmin's notFound() unchanged for a non-admin request", async () => {
    vi.mocked(guardAdmin).mockImplementation(async () => notFound());

    await expect(renderPage()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(readExposureCatalogFromControlPlane).not.toHaveBeenCalled();
  });
});
