/**
 * Maintainer-alert forensic detail surface guardian (#1050). Renders the
 * component with a full trace payload and proves it tabulates declared-vs-
 * computed like a bank cuadro, marks divergent rows, offers the close form only
 * while open, and links a regression back to its prior alert — all on canonical
 * paper primitives.
 */

import type { MaintainerAlertPayload } from "@web/asistente/maintainer-alert";
import type { MaintainerAlertWithOccurrences } from "@worthline/db";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { MaintainerAlertDetail } from "./maintainer-alert-detail";

const PAYLOAD: MaintainerAlertPayload = {
  category: "infidelity",
  summary: "El saldo persistido no lo reproduce la config actual.",
  holding: {
    id: "wl_hld_loan",
    label: "Préstamo coche",
    direction: "liability",
    instrument: "loan",
    valuationMethod: "amortized",
  },
  declared: {
    balanceMinor: 559_200,
    currency: "EUR",
    date: "2026-07-15",
    source: "extracto del banco",
  },
  calculationTrace: {
    object: "calculation_trace",
    holding: "wl_hld_loan",
    direction: "liability",
    model: "amortizable",
    asOf: "2026-07-15",
    currentValue: { amountMinor: 587_900, currency: "EUR" },
    schedule: {
      disbursementDate: "2024-01-01",
      firstPaymentDate: "2024-02-01",
      termMonths: 60,
      initialCapital: { amountMinor: 1_000_000, currency: "EUR" },
      effectiveFrom: "2024-01-01",
      frontiers: [
        {
          index: 1,
          date: "2024-02-01",
          openingBalance: { amountMinor: 1_000_000, currency: "EUR" },
          payment: { amountMinor: 18_000, currency: "EUR" },
          interest: { amountMinor: 2_500, currency: "EUR" },
          principal: { amountMinor: 15_500, currency: "EUR" },
          closingBalance: { amountMinor: 984_500, currency: "EUR" },
          annualInterestRate: "0.03",
          events: [],
        },
      ],
    },
    reconciliation: [
      {
        date: "2026-06-30",
        live: { amountMinor: 600_000, currency: "EUR" },
        persisted: { amountMinor: 595_000, currency: "EUR" },
        difference: { amountMinor: 5_000, currency: "EUR" },
        diverges: true,
        isSnapshot: true,
      },
    ],
    fidelity: {
      faithful: false,
      divergences: [],
      checkedPoints: 1,
    },
    tolerance: {
      band: { amountMinor: 294, currency: "EUR" },
      referenceBalance: { amountMinor: 587_900, currency: "EUR" },
      referenceDate: "2026-07-15",
      declared: {
        balance: { amountMinor: 559_200, currency: "EUR" },
        date: "2026-07-15",
        residual: { amountMinor: -28_700, currency: "EUR" },
        withinTolerance: false,
      },
    },
    omittedReconciliationPoints: 0,
  },
  raisedAt: "2026-07-15T10:00:00.000Z",
};

function alert(
  overrides: Partial<MaintainerAlertWithOccurrences> = {},
): MaintainerAlertWithOccurrences {
  return {
    id: "alert-1",
    workspaceId: "ws-ana",
    holdingId: "wl_hld_loan",
    category: "infidelity",
    status: "open",
    occurrenceCount: 1,
    firstSeenAt: "2026-07-15T10:00:00.000Z",
    lastSeenAt: "2026-07-15T10:00:00.000Z",
    resolutionNote: null,
    resolutionLink: null,
    resolvedAt: null,
    supersedesAlertId: null,
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
    occurrences: [
      { id: "occ-1", payload: PAYLOAD, occurredAt: "2026-07-15T10:00:00.000Z" },
    ],
    ...overrides,
  };
}

describe("MaintainerAlertDetail", () => {
  test("tabulates the trace and declared-vs-computed on paper, with the close form", () => {
    const html = renderToStaticMarkup(MaintainerAlertDetail({ alert: alert() }));

    expect(html).toContain('class="demoLanding maintainerAlerts"');
    expect(html).toContain("Infidelidad");
    expect(html).toContain("El saldo persistido no lo reproduce la config actual.");
    // Declared-vs-computed and the trace cuadro.
    expect(html).toContain("Reconciliación");
    expect(html).toContain("Cuadro de amortización");
    expect(html).toContain("alertDiverges");
    expect(html).toContain("extracto del banco");
    // Open ⇒ the close form is offered.
    expect(html).toContain("action=");
    expect(html).toContain('value="resolved"');
    expect(html).toContain('value="dismissed"');
  });

  test("shows the resolution and no close form once closed", () => {
    const html = renderToStaticMarkup(
      MaintainerAlertDetail({
        alert: alert({
          status: "resolved",
          resolutionNote: "bug de ripple arreglado",
          resolvedAt: "2026-07-16T00:00:00.000Z",
        }),
      }),
    );

    expect(html).toContain("Resuelta");
    expect(html).toContain("bug de ripple arreglado");
    expect(html).not.toContain('value="dismissed"');
  });

  test("links a regression back to the alert it supersedes", () => {
    const html = renderToStaticMarkup(
      MaintainerAlertDetail({ alert: alert({ supersedesAlertId: "alert-0" }) }),
    );
    expect(html).toContain('href="/admin/alertas/alert-0"');
    expect(html).toContain("Regresión");
  });

  test("degrades to a readable note when the trace could not be built", () => {
    const noTrace: MaintainerAlertPayload = {
      category: "sync_source",
      summary: "olor a sync",
      holding: null,
      calculationTrace: null,
      calculationTraceUnavailable: "no es una deuda con modelo",
      raisedAt: "2026-07-15T10:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      MaintainerAlertDetail({
        alert: alert({
          category: "sync_source",
          occurrences: [
            { id: "occ-1", payload: noTrace, occurredAt: "2026-07-15T10:00:00.000Z" },
          ],
        }),
      }),
    );
    expect(html).toContain("Sin traza de cálculo");
    expect(html).toContain("no es una deuda con modelo");
  });

  test("degrades a shape-drifted/corrupted trace to raw JSON instead of crashing", () => {
    // A stored payload whose trace lost its `fidelity`/`tolerance`/`reconciliation`
    // shape (a future contract change, or a truncated row) must not throw.
    const corrupt = {
      category: "infidelity",
      summary: "traza rara",
      holding: null,
      calculationTrace: { object: "calculation_trace", model: "amortizable" },
      raisedAt: "2026-07-15T10:00:00.000Z",
    } as unknown as MaintainerAlertPayload;

    const html = renderToStaticMarkup(
      MaintainerAlertDetail({
        alert: alert({
          occurrences: [
            { id: "occ-1", payload: corrupt, occurredAt: "2026-07-15T10:00:00.000Z" },
          ],
        }),
      }),
    );
    expect(html).toContain("formato no reconocido");
    expect(html).toContain("calculation_trace");
  });
});
