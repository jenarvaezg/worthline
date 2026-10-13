import {
  type ChipLedgerGroup,
  type ChipLedgerState,
  chipLedgerBasket,
  chipLedgerGroups,
  chipLedgerHighlight,
  chipLedgerHint,
  chipLedgerReducer,
  chipLedgerView,
  initialChipLedgerState,
} from "@web/chip-ledger-view";
import type { LiquidityTier, ManualAsset } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function asset(
  id: string,
  name: string,
  rung: LiquidityTier,
  euros: number,
  extra: Partial<ManualAsset> = {},
): ManualAsset {
  return {
    currency: "EUR",
    currentValue: { amountMinor: euros * 100, currency: "EUR" },
    id,
    isPrimaryResidence: false,
    liquidityTier: rung,
    name,
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
    ...extra,
  };
}

describe("chipLedgerGroups (#1837)", () => {
  test("agrupa por peldaño en el orden de la escalera y, dentro, de mayor a menor valor", () => {
    // El catálogo llega en el orden en que se dieron de alta: nada útil.
    const groups = chipLedgerGroups({
      options: [
        asset("coche", "Coche familiar", "illiquid", 14_500),
        asset("msci", "Fidelity MSCI World", "market", 48_210),
        asset("cuenta", "Cuenta BBVA", "cash", 8_420),
        asset("sp500", "Vanguard U.S. 500", "market", 15_870),
        asset("global", "Vanguard Global Stock", "market", 61_240),
      ],
      privacyMode: false,
      selectedIds: [],
    });

    expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual(
      [
        ["Caja", ["cuenta"]],
        ["Mercado", ["global", "msci", "sp500"]],
        ["Ilíquido", ["coche"]],
      ],
    );
  });

  test("a igual valor manda el orden del catálogo: la lista no baila entre cargas", () => {
    const groups = chipLedgerGroups({
      options: [
        asset("b", "Beta", "market", 1_000),
        asset("a", "Alfa", "market", 1_000),
        asset("c", "Gamma", "market", 2_000),
      ],
      privacyMode: false,
      selectedIds: [],
    });

    expect(groups[0]?.rows.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });

  test("cada fila dice si llegó marcada y lleva su valor, enmascarado en modo privacidad", () => {
    const options = [asset("msci", "Fidelity MSCI World", "market", 48_210)];

    const [visible] = chipLedgerGroups({
      options,
      privacyMode: false,
      selectedIds: ["msci"],
    });
    const [masked] = chipLedgerGroups({ options, privacyMode: true, selectedIds: [] });

    expect(visible?.rows[0]).toMatchObject({
      checked: true,
      name: "Fidelity MSCI World",
    });
    expect(visible?.rows[0]?.valueLabel).toMatch(/48\.210/);
    expect(masked?.rows[0]?.checked).toBe(false);
    expect(masked?.rows[0]?.valueLabel).not.toMatch(/\d/);
  });

  test("solo el gemelo lleva su código a la vista", () => {
    const [market] = chipLedgerGroups({
      options: [
        asset("acc", "Fidelity MSCI World", "market", 2, {
          securityId: { kind: "isin", value: "IE00BYX5NX33" },
        }),
        asset("dist", "Fidelity MSCI World", "market", 1, {
          securityId: { kind: "isin", value: "IE00BYX5MX67" },
        }),
        asset("sp500", "Vanguard U.S. 500", "market", 3, {
          securityId: { kind: "isin", value: "IE0032126645" },
        }),
      ],
      privacyMode: false,
      selectedIds: [],
    });

    expect(market?.rows.map((row) => [row.id, row.code])).toEqual([
      ["sp500", null],
      ["acc", "IE00BYX5NX33"],
      ["dist", "IE00BYX5MX67"],
    ]);
  });
});

/** Ocho fondos de Mercado, de mayor a menor: m1 vale más que m8. */
function marketOf(count: number, checkedIds: readonly string[] = []): ChipLedgerGroup[] {
  return chipLedgerGroups({
    options: Array.from({ length: count }, (_, index) =>
      asset(`m${index + 1}`, `Fondo ${index + 1}`, "market", 1_000 - index),
    ),
    privacyMode: false,
    selectedIds: checkedIds,
  });
}

function visibleIds(groups: ChipLedgerGroup[], state: ChipLedgerState): string[] {
  return chipLedgerView(groups, state).groups.flatMap((group) =>
    group.rows.filter((entry) => entry.visible).map((entry) => entry.row.id),
  );
}

describe("chipLedgerView — la ventana de cinco (#1837)", () => {
  test("cada grupo enseña sus cinco mayores y ofrece el resto", () => {
    const groups = marketOf(8);
    const view = chipLedgerView(groups, initialChipLedgerState(groups));

    expect(visibleIds(groups, initialChipLedgerState(groups))).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    expect(view.groups[0]?.more).toEqual({
      count: 3,
      kind: "more",
      label: "Ver 3 más de Mercado",
    });
  });

  test("una fila oculta por la ventana sigue en el libro: se esconde, no se desmonta", () => {
    const groups = marketOf(8);
    const view = chipLedgerView(groups, initialChipLedgerState(groups));

    expect(view.groups[0]?.rows.map((entry) => entry.row.id)).toHaveLength(8);
  });

  test("una fila marcada al cargar sigue a la vista aunque no esté entre los cinco", () => {
    const groups = marketOf(8, ["m7"]);
    const view = chipLedgerView(groups, initialChipLedgerState(groups));

    expect(visibleIds(groups, initialChipLedgerState(groups))).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m7",
    ]);
    expect(view.groups[0]?.more).toMatchObject({ count: 2, kind: "more" });
  });

  test("una fila tocada en la sesión no desaparece al plegar, ni recién desmarcada", () => {
    const groups = marketOf(8);
    const state: ChipLedgerState = {
      ...initialChipLedgerState(groups),
      touched: new Set(["m6"]),
    };

    expect(visibleIds(groups, state)).toContain("m6");
    expect(visibleIds(groups, state)).not.toContain("m8");
  });

  test("«ver más» enseña el grupo entero y ofrece volver a los cinco mayores", () => {
    const groups = marketOf(8);
    const state: ChipLedgerState = {
      ...initialChipLedgerState(groups),
      expanded: new Set(["market"]),
    };

    expect(visibleIds(groups, state)).toHaveLength(8);
    expect(chipLedgerView(groups, state).groups[0]?.more).toEqual({
      kind: "less",
      label: "Ver solo los 5 mayores",
    });
  });

  test("un grupo de cinco o menos no ofrece nada que desplegar", () => {
    const groups = marketOf(5);

    expect(chipLedgerView(groups, initialChipLedgerState(groups)).groups[0]?.more).toBe(
      null,
    );
  });
});

describe("chipLedgerView — grupos plegados y cabecera (#1837)", () => {
  const groups = chipLedgerGroups({
    options: [
      asset("cuenta", "Cuenta BBVA", "cash", 8_420),
      asset("coche", "Coche familiar", "illiquid", 14_500),
      asset("piso", "Piso Madrid", "housing", 385_000),
      asset("garaje", "Plaza de garaje", "housing", 24_000),
    ],
    privacyMode: false,
    selectedIds: ["garaje"],
  });

  function headers(state: ChipLedgerState) {
    return chipLedgerView(groups, state).groups.map((group) => ({
      chosen: group.chosenCount,
      count: group.count,
      foldable: group.foldable,
      open: group.open,
      rung: group.rung,
    }));
  }

  test("Ilíquido y Vivienda salen plegados; su cabecera es la que los despliega", () => {
    expect(headers(initialChipLedgerState(groups))).toEqual([
      { chosen: 0, count: "1", foldable: false, open: true, rung: "cash" },
      { chosen: 0, count: "1", foldable: true, open: false, rung: "illiquid" },
      // Plegado no esconde lo elegido: la cabecera lo cuenta.
      { chosen: 1, count: "2", foldable: true, open: false, rung: "housing" },
    ]);
  });

  test("desplegar un grupo plegado lo abre a él solo", () => {
    const state: ChipLedgerState = {
      ...initialChipLedgerState(groups),
      opened: new Set(["illiquid"]),
    };

    expect(headers(state).map((header) => header.open)).toEqual([true, true, false]);
  });

  test("«N elegidos» sigue a lo que se marca en la sesión, no a lo que llegó marcado", () => {
    const state: ChipLedgerState = {
      ...initialChipLedgerState(groups),
      selected: new Set(["cuenta", "coche"]),
    };

    expect(headers(state).map((header) => header.chosen)).toEqual([1, 1, 0]);
  });
});

describe("chipLedgerView — buscar (#1837)", () => {
  const groups = chipLedgerGroups({
    options: [
      ...Array.from({ length: 7 }, (_, index) =>
        asset(`etf${index}`, `ETF de relleno ${index}`, "market", 50_000 - index),
      ),
      asset("acc", "Fidelity MSCI World Index Fund", "market", 48_210, {
        securityId: { kind: "isin", value: "IE00BYX5NX33" },
      }),
      asset("dist", "Fidelity MSCI World Index Fund", "market", 9_800, {
        securityId: { kind: "isin", value: "IE00BYX5MX67" },
      }),
      asset("tef", "Telefónica", "market", 860, { providerSymbol: "TEF.MC" }),
      asset("plan", "Indexa Más Rentabilidad Acciones PP", "term-locked", 28_400, {
        securityId: { kind: "dgs", value: "N5396" },
      }),
      asset("oro", "Oro físico (monedas)", "illiquid", 9_200),
    ],
    privacyMode: false,
    selectedIds: [],
  });

  function search(query: string, selected: readonly string[] = []) {
    return chipLedgerView(groups, {
      ...initialChipLedgerState(groups),
      query,
      selected: new Set(selected),
    });
  }

  function matched(query: string): string[] {
    return search(query).groups.flatMap((group) =>
      group.rows.filter((entry) => entry.visible).map((entry) => entry.row.id),
    );
  }

  test("filtra por nombre sin distinguir mayúsculas ni tildes", () => {
    expect(matched("TELEFONICA")).toEqual(["tef"]);
    expect(matched("telefónica")).toEqual(["tef"]);
    expect(matched("  rentabilidad ")).toEqual(["plan"]);
  });

  test("filtra por ISIN, por código DGS y por símbolo", () => {
    expect(matched("ie00byx5mx67")).toEqual(["dist"]);
    expect(matched("N5396")).toEqual(["plan"]);
    expect(matched("tef.mc")).toEqual(["tef"]);
  });

  test("buscando no hay ventana: salen todas las coincidencias, aunque pasen de cinco", () => {
    expect(matched("relleno")).toHaveLength(7);
    expect(search("relleno").groups[0]?.more).toBe(null);
  });

  test("lo que no coincide se esconde, pero sigue en el libro", () => {
    const view = search("zzz");

    expect(view.matchCount).toBe(0);
    expect(view.groups.flatMap((group) => group.rows)).toHaveLength(12);
    expect(view.groups.every((group) => !group.shown)).toBe(true);
  });

  test("la cabecera cuenta «m de N» y un grupo sin coincidencias desaparece", () => {
    const view = search("fidelity");

    expect(view.groups.map((group) => [group.rung, group.shown, group.count])).toEqual([
      ["market", true, "2 de 10"],
      ["term-locked", false, "0 de 1"],
      ["illiquid", false, "0 de 1"],
    ]);
    expect(view.matchCount).toBe(2);
  });

  test("una búsqueda que coincide dentro de un grupo plegado lo abre", () => {
    const illiquid = search("oro").groups.find((group) => group.rung === "illiquid");

    expect(illiquid).toMatchObject({ foldable: false, open: true, shown: true });
  });

  test("la fila señalada es la primera coincidencia sin elegir, en el orden del libro", () => {
    expect(search("fidelity").target?.row.id).toBe("acc");
    expect(search("fidelity", ["acc"]).target?.row.id).toBe("dist");
    // Con su peldaño: Enter lo deja abierto al añadir.
    expect(search("oro").target?.rung).toBe("illiquid");
    expect(search("fidelity", ["acc", "dist"]).target).toBe(null);
    // Sin búsqueda no hay nada que Enter pueda añadir.
    expect(search("").target).toBe(null);

    const flagged = search("fidelity")
      .groups.flatMap((group) => group.rows)
      .filter((entry) => entry.target)
      .map((entry) => entry.row.id);
    expect(flagged).toEqual(["acc"]);
  });

  test("la pista dice qué añadiría Enter, con el código del gemelo, y cuántas coinciden", () => {
    expect(chipLedgerHint(search("fidelity"))).toEqual({
      kind: "enter",
      label: "Fidelity MSCI World Index Fund (IE00BYX5NX33)",
      tail: " · 2 coincidencias",
    });
    // Una sola coincidencia no necesita recuento, y un nombre único no lleva código.
    expect(chipLedgerHint(search("telefonica"))).toEqual({
      kind: "enter",
      label: "Telefónica",
      tail: "",
    });
  });

  test("si todo lo que coincide ya está elegido, o nada coincide, la pista lo dice", () => {
    expect(chipLedgerHint(search("fidelity", ["acc", "dist"]))).toEqual({
      kind: "text",
      text: "2 coincidencias, todas elegidas",
    });
    expect(chipLedgerHint(search("telefonica", ["tef"]))).toEqual({
      kind: "text",
      text: "1 coincidencia, ya elegida",
    });
    expect(chipLedgerHint(search("zzz"))).toEqual({
      kind: "text",
      text: "Ninguna coincidencia",
    });
  });

  test("en reposo, la pista cuenta el catálogo y dice cómo está ordenado", () => {
    expect(chipLedgerHint(search(""))).toEqual({
      kind: "text",
      text: "12 activos · los mayores de cada grupo primero",
    });
  });
});

describe("chipLedgerHighlight (#1837)", () => {
  test("resalta la coincidencia en el texto tal como se lee, con sus tildes", () => {
    expect(chipLedgerHighlight("Telefónica", "FONICA")).toEqual([
      { hit: false, text: "Tele" },
      { hit: true, text: "fónica" },
    ]);
    expect(chipLedgerHighlight("Fidelity MSCI World", " msci ")).toEqual([
      { hit: false, text: "Fidelity " },
      { hit: true, text: "MSCI" },
      { hit: false, text: " World" },
    ]);
  });

  test("una tilde escrita aparte no parte la letra que la lleva", () => {
    // «o» + acento combinante (U+0301): lo que pega un PDF o un extracto.
    expect(chipLedgerHighlight("Telefo\u0301nica", "fonica")).toEqual([
      { hit: false, text: "Tele" },
      { hit: true, text: "fónica" },
    ]);
  });

  test("sin búsqueda, o si coincide solo el código, el nombre sale entero", () => {
    expect(chipLedgerHighlight("Fidelity MSCI World", "")).toEqual([
      { hit: false, text: "Fidelity MSCI World" },
    ]);
    expect(chipLedgerHighlight("Fidelity MSCI World", "IE00BYX5NX33")).toEqual([
      { hit: false, text: "Fidelity MSCI World" },
    ]);
  });
});

describe("chipLedgerReducer y la cesta (#1837)", () => {
  const groups = chipLedgerGroups({
    options: [
      asset("cuenta", "Cuenta BBVA", "cash", 8_420),
      asset("global", "Vanguard Global Stock", "market", 61_240),
      asset("msci", "Fidelity MSCI World", "market", 48_210),
      asset("plan", "Plan de empleo", "term-locked", 16_720),
    ],
    privacyMode: false,
    selectedIds: ["plan", "global"],
  });
  const initial = initialChipLedgerState(groups);

  function basketIds(state: ChipLedgerState): string[] {
    return chipLedgerBasket(groups, state).map((row) => row.id);
  }

  test("la cesta arranca con lo marcado al cargar, en el orden del libro", () => {
    expect(basketIds(initial)).toEqual(["global", "plan"]);
  });

  test("marcar añade al final de la cesta y desmarcar lo quita; ambas tocan la fila", () => {
    const marked = chipLedgerReducer(initial, {
      checked: true,
      id: "cuenta",
      type: "toggle",
    });
    const unmarked = chipLedgerReducer(marked, {
      checked: false,
      id: "global",
      type: "toggle",
    });

    expect(basketIds(marked)).toEqual(["global", "plan", "cuenta"]);
    expect(basketIds(unmarked)).toEqual(["plan", "cuenta"]);
    expect([...unmarked.touched]).toEqual(["cuenta", "global"]);
  });

  test("Enter añade la fila señalada y limpia la búsqueda", () => {
    const searching = chipLedgerReducer(initial, { query: "fidelity", type: "search" });
    const added = chipLedgerReducer(searching, {
      id: "msci",
      rung: "market",
      type: "add",
    });

    expect(added.query).toBe("");
    expect(basketIds(added)).toEqual(["global", "plan", "msci"]);
    expect(added.touched.has("msci")).toBe(true);
  });

  test("Enter sobre una fila de un grupo plegado lo deja abierto: lo añadido no se esconde al limpiar", () => {
    // La búsqueda abrió Ilíquido para enseñar el coche; si al limpiarla el grupo se
    // volviera a plegar, lo recién añadido desaparecería bajo el dedo.
    const groupsWithCar = chipLedgerGroups({
      options: [
        asset("cuenta", "Cuenta BBVA", "cash", 8_420),
        asset("coche", "Coche familiar", "illiquid", 14_500),
      ],
      privacyMode: false,
      selectedIds: [],
    });
    const searching = chipLedgerReducer(initialChipLedgerState(groupsWithCar), {
      query: "coche",
      type: "search",
    });
    const added = chipLedgerReducer(searching, {
      id: "coche",
      rung: "illiquid",
      type: "add",
    });
    const illiquid = chipLedgerView(groupsWithCar, added).groups.find(
      (group) => group.rung === "illiquid",
    );

    expect(illiquid).toMatchObject({ foldable: true, open: true });
    expect(illiquid?.rows.map((entry) => entry.visible)).toEqual([true]);
  });

  test("plegar y «ver más» se conmutan por peldaño", () => {
    const opened = chipLedgerReducer(initial, { rung: "illiquid", type: "fold" });
    const expanded = chipLedgerReducer(opened, { rung: "market", type: "window" });

    expect([...expanded.opened]).toEqual(["illiquid"]);
    expect([...expanded.expanded]).toEqual(["market"]);
    expect(
      chipLedgerReducer(expanded, { rung: "illiquid", type: "fold" }).opened.size,
    ).toBe(0);
  });

  test("una casilla que el navegador restauró marcada fuera de los cinco mayores sigue a la vista", () => {
    // Volver atrás restaura las casillas: la que quedó marcada sale en la cesta, y
    // en el libro tampoco puede esconderse tras «Ver N más».
    const many = chipLedgerGroups({
      options: Array.from({ length: 8 }, (_, index) =>
        asset(`m${index + 1}`, `Fondo ${index + 1}`, "market", 1_000 - index),
      ),
      privacyMode: false,
      selectedIds: [],
    });
    const synced = chipLedgerReducer(initialChipLedgerState(many), {
      checkedIds: ["m8"],
      type: "sync",
    });

    expect(
      chipLedgerView(many, synced)
        .groups[0]?.rows.filter((entry) => entry.visible)
        .map((entry) => entry.row.id),
    ).toContain("m8");
  });

  test("al hidratar, la cesta se pone al día con las casillas que el navegador ya tocó", () => {
    // Un toque antes de hidratar, o el formulario que el navegador restaura al
    // volver atrás: lo que se enviará es el DOM, y la cesta tiene que decir lo mismo.
    const synced = chipLedgerReducer(initial, {
      checkedIds: ["cuenta", "plan"],
      type: "sync",
    });

    expect(basketIds(synced)).toEqual(["cuenta", "plan"]);
    // Sin diferencias no hay estado nuevo, ni repintado.
    expect(
      chipLedgerReducer(initial, { checkedIds: ["global", "plan"], type: "sync" }),
    ).toBe(initial);
  });
});
