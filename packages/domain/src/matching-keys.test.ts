import { describe, expect, test } from "vitest";

import { matchHoldings } from "./holding-matcher";
import {
  classifiedMatchKey,
  instrumentsCompatible,
  matchKeyNamespace,
  providerSymbolMatchKey,
  securityIdMatchKey,
  symbolMatchKeyVariant,
} from "./matching-keys";
import { resolveStatementImportBuckets } from "./statement-import-plan";
import { parseStatement } from "./statement-parse";

describe("namespaced match keys (#1748, enmienda ADR 0055)", () => {
  test("a typed pair claims the key of its OWN kind, never the other's", () => {
    expect(securityIdMatchKey({ kind: "isin", value: "ES00WL000009" })).toBe(
      "isin:ES00WL000009",
    );
    expect(securityIdMatchKey({ kind: "dgs", value: "N5394" })).toBe("dgs:N5394");
    // The same five characters in the two registers are two different keys.
    expect(securityIdMatchKey({ kind: "isin", value: "N5394" })).not.toBe("dgs:N5394");
  });

  test("a mistyped pair claims NO key, so it cannot match in silence", () => {
    // `dgs` holding whose value is an ISIN, and `isin` holding whose value is a
    // plan code: both are the mis-typing the namespace exists to expose.
    expect(securityIdMatchKey({ kind: "dgs", value: "ES00WL000009" })).toBeNull();
    expect(securityIdMatchKey({ kind: "isin", value: "N5394" })).toBeNull();
    expect(securityIdMatchKey(null)).toBeNull();
  });

  test("a typed pair is normalized once: case and the DGS dash", () => {
    expect(securityIdMatchKey({ kind: "isin", value: " es00wl000009 " })).toBe(
      "isin:ES00WL000009",
    );
    expect(securityIdMatchKey({ kind: "dgs", value: "n-5394" })).toBe("dgs:N5394");
  });

  test("a raw identifier is classified BY SHAPE at the seam", () => {
    expect(classifiedMatchKey("ES00WL000009")).toBe("isin:ES00WL000009");
    expect(classifiedMatchKey("N5394")).toBe("dgs:N5394");
    expect(classifiedMatchKey("N-5394")).toBe("dgs:N5394");
    // The finect slug keeps routing as a provider symbol, plan code inside or not.
    expect(classifiedMatchKey("N5394-Myinvestor_pp")).toBe("sym:N5394-Myinvestor_pp");
    expect(classifiedMatchKey("bitcoin")).toBe("sym:bitcoin");
    expect(classifiedMatchKey("  ")).toBeNull();
  });

  test("the symbol lane keeps its case variants (#695)", () => {
    expect(providerSymbolMatchKey("bitcoin")).toBe("sym:bitcoin");
    expect(providerSymbolMatchKey("IWDA.AS")).toBe("sym:IWDA.AS");
    expect(symbolMatchKeyVariant("sym:Bitcoin")).toBe("sym:bitcoin");
    // Only the symbol lane is case-insensitive: an identifier is uppercase or nothing.
    expect(symbolMatchKeyVariant("sym:bitcoin")).toBeNull();
    expect(symbolMatchKeyVariant("isin:ES00WL000009")).toBeNull();
    expect(symbolMatchKeyVariant("dgs:N5394")).toBeNull();
  });

  test("the namespace of a key names which register it belongs to", () => {
    expect(matchKeyNamespace("isin:ES00WL000009")).toBe("isin");
    expect(matchKeyNamespace("dgs:N5394")).toBe("dgs");
    expect(matchKeyNamespace("sym:bitcoin")).toBe("sym");
    expect(matchKeyNamespace("ES00WL000009")).toBeNull();
  });

  test("instruments are compatible unless BOTH are declared and differ", () => {
    expect(instrumentsCompatible("fund", "fund")).toBe(true);
    expect(instrumentsCompatible("fund", "pension_plan")).toBe(false);
    expect(instrumentsCompatible(null, "pension_plan")).toBe(true);
    expect(instrumentsCompatible("fund", undefined)).toBe(true);
  });
});

/**
 * The acceptance of #1748: the same file resolves the same way through the two
 * doors — the assistant's reconcile matcher and the statement importer. They
 * agree because the keys are built here, once; a divergence would mean one of
 * them grew a second reading of «the same key» (#1366).
 */
describe("both doors read one file the same way (#1366/#1748)", () => {
  const PLAN = { kind: "dgs" as const, value: "N5394" };
  const FUND = { kind: "isin" as const, value: "ES00WL000009" };

  const holdings = [
    { holdingId: "plan", name: "Plan Indexado", securityId: PLAN },
    { holdingId: "fund", name: "Fondo Indexado", securityId: FUND },
    { holdingId: "crypto", name: "Bitcoin", providerSymbol: "bitcoin" },
  ];

  const investments = holdings.map((holding) => ({
    assetId: holding.holdingId,
    name: holding.name,
    operations: [],
    ...(holding.securityId ? { securityId: holding.securityId } : {}),
    ...(holding.providerSymbol ? { providerSymbol: holding.providerSymbol } : {}),
  }));

  const FILE = [
    "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
    "05/01/2026;Plan de pensiones;N-5394;Compra;34,2857;1200;;",
    "06/01/2026;Fondo;es00wl000009;Compra;10,0000;1000;;",
    "07/01/2026;Cripto;Bitcoin;Compra;0,0100;600;;",
  ].join("\r\n");

  test("identifier by identifier, both doors land on the same holding", () => {
    const parsed = parseStatement(FILE, "plantilla");
    if (!parsed.ok) throw new Error(parsed.errors.join(" | "));

    // The importer's door: one bucket per identifier, each resolved to a holding.
    const byImporter = resolveStatementImportBuckets(parsed.value, investments).map(
      (bucket) => [bucket.isin, bucket.bucket === "matched" ? bucket.assetId : null],
    );

    // The assistant's door: the SAME rows as candidate rows, matched by key. The
    // seam classifies the raw identifier exactly as the importer's does.
    const byAssistant = parsed.value.rows.map((row) => {
      const [match] = matchHoldings(
        [
          {
            rowId: row.isin ?? "",
            isin: row.isin,
            ...(row.instrument ? { instrument: row.instrument } : {}),
          },
        ],
        holdings,
      );
      const key = classifiedMatchKey(row.isin);
      return [key === null ? "" : key.slice(key.indexOf(":") + 1), match?.target ?? null];
    });

    expect(byImporter).toEqual([
      ["N5394", "plan"],
      ["ES00WL000009", "fund"],
      ["Bitcoin", "crypto"],
    ]);
    expect(byAssistant).toEqual(byImporter);
  });
});
