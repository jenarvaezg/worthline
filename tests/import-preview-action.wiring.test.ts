/**
 * Wiring suite: previewImportAction (app/ajustes/actions.ts, issue #104).
 *
 * FormData in → serializable preview state out. The preview NEVER touches the
 * DB: it only reads the uploaded file, validates it with parseWorkspaceExport,
 * and summarizes it. @worthline/db is mocked to throw so any store access
 * fails the test loudly.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The preview must be DB-free by construction: the module under test imports
// withStore for its sibling actions, so make any call to it blow up.
const withStoreSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("previewImportAction must not touch the DB");
  }),
);
vi.mock("@worthline/db", () => ({ withStore: withStoreSpy }));

import { type ImportPreviewState, previewImportAction } from "@web/ajustes/actions";

// ------------------------------------------------------------------ helpers --

const IDLE: ImportPreviewState = { status: "idle" };

/** A valid version-2 export document with known per-section counts (#155). */
const validDoc = {
  version: 2,
  workspace: { mode: "individual", baseCurrency: "EUR" },
  members: [
    { id: "m1", name: "Ana" },
    { id: "m2", name: "Bea" },
  ],
  assets: [
    {
      id: "a1",
      name: "Cuenta",
      type: "cash",
      currency: "EUR",
      currentValue: { amountMinor: 100000, currency: "EUR" },
      liquidityTier: "cash",
      ownership: [{ memberId: "m1", shareBps: 10000 }],
    },
  ],
};

function fdWithFile(contents: string): FormData {
  const form = new FormData();
  form.set("file", new File([contents], "export.json", { type: "application/json" }));
  return form;
}

// ====================================================== previewImportAction

describe("previewImportAction wiring", () => {
  test("valid file → summary state with the document's exact counts", async () => {
    const state = await previewImportAction(IDLE, fdWithFile(JSON.stringify(validDoc)));

    expect(state).toEqual({
      status: "summary",
      summary: {
        members: 2,
        groups: 0,
        assets: 1,
        liabilities: 0,
        operations: 0,
        snapshots: 0,
        trashedAssets: 0,
        trashedLiabilities: 0,
        warningOverrides: 0,
        priceCacheEntries: 0,
        fireConfigScopes: 0,
        connectedSources: 0,
        exposureProfiles: 0,
        payouts: 0,
        payoutSchedules: 0,
      },
    });
  });

  test("invalid document (wrong version) → error state carrying the validation message", async () => {
    const state = await previewImportAction(
      IDLE,
      fdWithFile(JSON.stringify({ ...validDoc, version: 99 })),
    );

    expect(state.status).toBe("error");
    expect(state.status === "error" && state.errors.join(" ")).toContain("versión 99");
  });

  test("malformed JSON → clear Spanish error state", async () => {
    const state = await previewImportAction(IDLE, fdWithFile("{not json"));

    expect(state).toEqual({
      status: "error",
      errors: ["El archivo no contiene JSON válido y no se puede importar."],
    });
  });

  test("missing file → Spanish error state", async () => {
    const state = await previewImportAction(IDLE, new FormData());

    expect(state.status).toBe("error");
    expect(state.status === "error" && state.errors[0]).toMatch(/archivo/i);
  });

  test("empty file → Spanish error state", async () => {
    const state = await previewImportAction(IDLE, fdWithFile(""));

    expect(state.status).toBe("error");
  });

  test("never touches the DB on any path", async () => {
    await previewImportAction(IDLE, fdWithFile(JSON.stringify(validDoc)));
    await previewImportAction(IDLE, fdWithFile("{not json"));
    await previewImportAction(IDLE, new FormData());

    expect(withStoreSpy).not.toHaveBeenCalled();
  });
});
