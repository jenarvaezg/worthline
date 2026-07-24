import { describe, expect, it } from "vitest";

import { NAV_SECTIONS, sectionForPath } from "./active-section";

describe("sectionForPath", () => {
  it("maps each top-level tab route to its section", () => {
    expect(sectionForPath("/app")).toBe("resumen");
    expect(sectionForPath("/patrimonio")).toBe("patrimonio");
    expect(sectionForPath("/historico")).toBe("historico");
    expect(sectionForPath("/objetivos")).toBe("objetivos");
    expect(sectionForPath("/ajustes")).toBe("ajustes");
  });

  it("highlights patrimonio on its nested drilldown routes (AC2)", () => {
    expect(sectionForPath("/patrimonio/anadir")).toBe("patrimonio");
    expect(sectionForPath("/patrimonio/anadir/avanzado")).toBe("patrimonio");
    expect(sectionForPath("/patrimonio/actualizar")).toBe("patrimonio");
    expect(sectionForPath("/patrimonio/importar-extracto")).toBe("patrimonio");
    expect(sectionForPath("/patrimonio/asset_123/editar")).toBe("patrimonio");
  });

  it("keeps /premium under the Ajustes tab (its paywall entry point)", () => {
    expect(sectionForPath("/premium")).toBe("ajustes");
  });

  it("returns null for routes outside the workspace chrome", () => {
    expect(sectionForPath("/")).toBeNull();
    expect(sectionForPath("/login")).toBeNull();
    expect(sectionForPath("/bienvenida")).toBeNull();
    // A route that merely shares a prefix with a tab must not false-match.
    expect(sectionForPath("/applications")).toBeNull();
    expect(sectionForPath("/objetivos-something")).toBeNull();
  });

  it("exposes the nav sections in tab order", () => {
    expect(NAV_SECTIONS.map((section) => section.id)).toEqual([
      "resumen",
      "patrimonio",
      "historico",
      "objetivos",
      "ajustes",
    ]);
  });
});
