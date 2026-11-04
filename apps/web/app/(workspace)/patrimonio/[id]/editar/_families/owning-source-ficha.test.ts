/**
 * The band of a holding MyInvestor owns (#1884, #1885): the connection's lasting
 * state, its health signals and this holding's units, each with its way out.
 */
import { myInvestorStanding } from "@web/ajustes/myinvestor-sync-view";
import { describe, expect, test } from "vitest";

import { type OwningSourceFicha, owningSourceNotices } from "./owning-source-ficha";

const NOW = "2026-11-04T11:04:00.000Z";

function owned(overrides: Partial<OwningSourceFicha> = {}): OwningSourceFicha {
  return {
    anyMismatch: false,
    health: [],
    label: "MyInvestor",
    lastGood: "hoy, 07:13",
    readOnly: false,
    savedPassword: true,
    sourceId: "src_myinvestor",
    standing: myInvestorStanding({ now: NOW, savedPassword: true, state: null }),
    unitsLine: null,
    ...overrides,
  };
}

const input = { currentUrl: "/patrimonio/wl_hld_x/editar", tabs: ["resumen"] };

describe("the band of an owned holding", () => {
  test("nothing wrong, nothing in the band", () => {
    expect(owningSourceNotices(owned(), input)).toEqual([]);
  });

  test("a health signal goes to the band with «Ver la conexión →» to Conexiones", () => {
    const notices = owningSourceNotices(
      owned({
        health: [
          {
            remedy: { kind: "conexiones", label: "Ver la conexión →" },
            text: "El conector falla al leer las órdenes desde hace 3 días.",
            tone: "warn",
          },
        ],
      }),
      input,
    );

    expect(notices).toEqual([
      {
        key: "health-0",
        remedy: { href: "/ajustes/conexiones", label: "Ver la conexión →" },
        text: "El conector falla al leer las órdenes desde hace 3 días.",
      },
    ]);
  });

  test("the lasting state goes first, the health after, the units last", () => {
    const notices = owningSourceNotices(
      owned({
        health: [
          {
            remedy: { kind: "conexiones", label: "Ver la conexión →" },
            text: "El conector falla al leer los planes desde hace 4 días.",
            tone: "warn",
          },
        ],
        standing: myInvestorStanding({
          now: NOW,
          savedPassword: true,
          state: {
            lastOutcomeJson: null,
            lease: null,
            pausedUntil: null,
            stoppedReason: "sms_required",
          },
        }),
        unitsLine: "Las participaciones no cuadran.",
      }),
      input,
    );

    expect(notices.map((notice) => notice.key)).toEqual([
      "connection",
      "health-0",
      "units",
    ]);
  });
});
