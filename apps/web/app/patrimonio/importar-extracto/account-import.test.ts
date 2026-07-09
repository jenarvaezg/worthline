/**
 * Account-sized end-to-end coverage for "Importar extracto" (PRD #669 S3,
 * #674, ADR 0055): a synthetic whole-account plantilla export (20 ISINs, 80
 * operation lines — the shape of a real multi-fund broker export) driving the same
 * preview → confirm actions as `actions.test.ts`, via the `_store` injection
 * seam (a real in-memory store, not mocked). No Playwright spec exists for the
 * per-holding statement upload either (#176 — `inversiones/statement-actions.
 * test.ts` is action-level only); a browser-driven upload of a 100-row CSV
 * would add nothing an action-level test hitting the real store can't already
 * prove for the ripple/idempotency seam under test here.
 *
 * Pins the S3 acceptance criteria at account scale:
 *   1. Full-file import reconstructs every fund's operations AND ripples one
 *      snapshot per contribution date, across matched (pre-existing) and new
 *      (created-by-import) funds together.
 *   2. Re-uploading the identical file is a no-op: no new holdings, no new
 *      operations, snapshots unchanged (ADR 0055 §6).
 */

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  confirmImportStatementAction,
  type ImportStatementPreviewState,
  type IsinSymbolResolver,
  previewImportStatementAction,
} from "./actions";

// Demo-ness is a per-request fact — the logged-out persona cookie resolved by
// the store seam (ADR 0030). Default undefined = live; the demo test flips it.
let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

const IDLE: ImportStatementPreviewState = { status: "idle" };

// 20 synthetic WL-tagged ISINs (one country prefix each, so no two collide) ×
// 4 rows = 80 operation lines — the shape of ADR 0055's real case ("153 orders
// across 26 ISINs") at fixture scale.
const ISIN_COUNTRIES = [
  "ES",
  "LU",
  "IE",
  "FR",
  "DE",
  "NL",
  "IT",
  "PT",
  "BE",
  "AT",
  "FI",
  "GR",
  "US",
  "GB",
  "CH",
  "SE",
  "DK",
  "NO",
  "PL",
  "CZ",
] as const;

const ALL_ISINS = ISIN_COUNTRIES.map(
  (country, i) => `${country}00WL${String(i + 1).padStart(6, "0")}`,
);
const MATCHED_ISINS = ALL_ISINS.slice(0, 6);

// Four monthly contributions (the 5th of each month, like a recurring buy
// order) at a fixed price of 100/unit: amounts 100/200/300/400 EUR -> units
// 1/2/3/4.
const ORDER_DATES = ["05/01/2024", "05/02/2024", "05/03/2024", "05/04/2024"];
const SNAPSHOT_DATE_KEYS = ["2024-01-05", "2024-02-05", "2024-03-05", "2024-04-05"];

function accountCsvRows(): string[] {
  return ALL_ISINS.flatMap((isin) =>
    ORDER_DATES.map(
      (date, i) => `${date};Fondo;${isin};Compra;${i + 1},0000;${(i + 1) * 100};;`,
    ),
  );
}

// CRLF, dd/mm/yyyy, comma-decimal units, `;`-delimited — the Worthline plantilla.
const ACCOUNT_CSV = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  ...accountCsvRows(),
].join("\r\n");

async function seedAccount(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await Promise.all(
    MATCHED_ISINS.map((isin, i) =>
      store.assets.createInvestmentAsset({
        currency: "EUR",
        id: `matched_${i}`,
        isin,
        liquidityTier: "market",
        name: `Fondo existente ${i + 1}`,
        ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      }),
    ),
  );
}

// Never hits live Yahoo (mirrors actions.test.ts's fakeResolver) — every new
// ISIN resolves to nothing, so this test never depends on network price fetch.
const notFoundResolver: IsinSymbolResolver = async () => ({ status: "not_found" });

function uploadForm(): FormData {
  const fd = new FormData();
  fd.set("broker", "plantilla");
  fd.set("currentUrl", "/patrimonio/importar-extracto");
  fd.set("file", new File([ACCOUNT_CSV], "plantilla.csv", { type: "text/csv" }));
  return fd;
}

function confirmForm(): FormData {
  const fd = uploadForm();
  for (const isin of ALL_ISINS) {
    fd.set(`include_${isin}`, "on");
  }
  return fd;
}

async function previewAccount(
  store: WorthlineStore,
): Promise<ImportStatementPreviewState> {
  return previewImportStatementAction(IDLE, uploadForm(), store, notFoundResolver);
}

async function confirmAccount(store: WorthlineStore): Promise<string> {
  try {
    await confirmImportStatementAction(confirmForm(), store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

/** (dateKey, grossAssets) pairs, sorted — the semantic content of a snapshot
 * band, ignoring volatile fields (id, capturedAt) irrelevant to "unchanged". */
async function snapshotFingerprint(store: WorthlineStore): Promise<string[]> {
  const snapshots = await store.snapshots.readSnapshots();
  return snapshots.map((s) => `${s.dateKey}:${s.grossAssets.amountMinor}`).sort();
}

describe("account-sized statement import — full reconstruction (S3, #674)", () => {
  test("a whole-account export reconstructs every fund's operations and ripples one snapshot per contribution date", async () => {
    const store = await createInMemoryStore();
    await seedAccount(store);

    const preview = await previewAccount(store);
    if (preview.status !== "ready") throw new Error("expected a ready preview");
    expect(preview.funds).toHaveLength(20);
    expect(preview.funds.filter((f) => f.bucket === "matched")).toHaveLength(6);
    expect(preview.funds.filter((f) => f.bucket === "new")).toHaveLength(14);
    for (const fund of preview.funds) {
      expect(fund.executedCount).toBe(4);
      expect(fund.skippedCount).toBe(0);
    }

    const digest = await confirmAccount(store);
    expect(digest).toContain("ok=statement_import_loaded");
    expect(digest).toContain("funds=20");
    expect(digest).toContain("created=14");

    const metas = await store.assets.readInvestmentAssetsWithMeta();
    expect(metas).toHaveLength(20);

    for (const isin of ALL_ISINS) {
      const meta = metas.find((m) => m.isin === isin);
      expect(meta).toBeDefined();
      const ops = await store.operations.readOperations(meta!.id);
      expect(ops).toHaveLength(4);
    }

    const snapshots = await store.snapshots.readSnapshots();
    expect([...new Set(snapshots.map((s) => s.dateKey))].sort()).toEqual(
      SNAPSHOT_DATE_KEYS,
    );

    const grossAt = (dateKey: string) =>
      snapshots.find((s) => s.dateKey === dateKey)?.grossAssets.amountMinor;
    expect(grossAt("2024-01-05")).toBe(20 * 100_00);
    expect(grossAt("2024-02-05")).toBe(20 * 300_00);
    expect(grossAt("2024-03-05")).toBe(20 * 600_00);
    expect(grossAt("2024-04-05")).toBe(20 * 1000_00);

    store.close();
  });

  test("re-uploading the identical export is a no-op: zero new holdings, zero new operations, snapshots unchanged", async () => {
    const store = await createInMemoryStore();
    await seedAccount(store);
    await confirmAccount(store);

    const metasBefore = await store.assets.readInvestmentAssetsWithMeta();
    expect(metasBefore).toHaveLength(20);
    const opsCountBefore = new Map(
      await Promise.all(
        metasBefore.map(
          async (m) =>
            [m.isin, (await store.operations.readOperations(m.id)).length] as const,
        ),
      ),
    );
    const fingerprintBefore = await snapshotFingerprint(store);

    const digest = await confirmAccount(store);
    expect(digest).toContain("funds=20");
    expect(digest).toContain("created=0");

    const metasAfter = await store.assets.readInvestmentAssetsWithMeta();
    expect(metasAfter).toHaveLength(20);

    const opsCountAfter = new Map(
      await Promise.all(
        metasAfter.map(
          async (m) =>
            [m.isin, (await store.operations.readOperations(m.id)).length] as const,
        ),
      ),
    );
    expect(opsCountAfter).toEqual(opsCountBefore);
    expect([...opsCountAfter.values()].reduce((sum, n) => sum + n, 0)).toBe(80);

    expect(await snapshotFingerprint(store)).toEqual(fingerprintBefore);

    store.close();
  });
});

describe("demo write-gating (S3, #674 — PRD #669 story 17)", () => {
  test("confirm in demo mode redirects with the deshabilitado message and writes nothing", async () => {
    const store = await createInMemoryStore();
    await seedAccount(store);

    mockPersonaCookie = "familia";
    const digest = await confirmAccount(store);
    const decoded = decodeURIComponent(digest.replace(/\+/g, " "));
    expect(decoded).toContain(DEMO_DISABLED_MESSAGE);

    const metas = await store.assets.readInvestmentAssetsWithMeta();
    expect(metas).toHaveLength(6);
    for (const meta of metas) {
      expect(await store.operations.readOperations(meta.id)).toHaveLength(0);
    }
    expect(await snapshotFingerprint(store)).toEqual([]);

    store.close();
  });
});
