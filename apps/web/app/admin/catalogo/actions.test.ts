/**
 * Catalog action tests (PRD #711 S4, guard #938 eje 1). Every verb re-verifies
 * `guardAdmin` as its first line: a direct call with a non-admin / logged-out /
 * demo session — or with `WORTHLINE_ADMIN_EMAIL` empty — 404s byte-identically
 * to an unknown URL, and the control-plane store is never opened (no observable
 * write). With an admin session the verb persists and returns the typed result;
 * a domain contract violation surfaces as `{ status: "error" }`, never a throw.
 */
import type { ControlPlaneStore } from "@worthline/db";
import type { GlobalExposureProfile } from "@worthline/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeSession = { user?: { email?: string | null } } | null;

let mockSession: FakeSession = null;
const storeSpies = {
  create: vi.fn(),
  update: vi.fn(),
  rekey: vi.fn(),
  delete: vi.fn(),
};
const withControlPlaneStore = vi.fn(
  async (run: (store: ControlPlaneStore) => unknown) => {
    const store = {
      createGlobalExposureProfile: storeSpies.create,
      updateGlobalExposureProfile: storeSpies.update,
      rekeyGlobalExposureProfile: storeSpies.rekey,
      deleteGlobalExposureProfile: storeSpies.delete,
    } as unknown as ControlPlaneStore;
    return run(store);
  },
);

vi.mock("@web/auth", () => ({
  auth: async (): Promise<FakeSession> => mockSession,
}));

vi.mock("@web/admin/admin-control-plane", () => ({
  withControlPlaneStore: (run: (store: ControlPlaneStore) => unknown) =>
    withControlPlaneStore(run),
}));

import {
  deleteCatalogProfileAction,
  rekeyCatalogProfileAction,
  saveCatalogProfileAction,
} from "./actions";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mockSession = null;
  vi.clearAllMocks();
});

function asAdmin(): void {
  process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
  process.env.AUTH_GOOGLE_ID = "google-id";
  process.env.AUTH_GOOGLE_SECRET = "google-secret";
  mockSession = { user: { email: "admin@example.com" } };
}

function asNonAdmin(): void {
  process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
  process.env.AUTH_GOOGLE_ID = "google-id";
  process.env.AUTH_GOOGLE_SECRET = "google-secret";
  mockSession = { user: { email: "someone-else@example.com" } };
}

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

function sampleProfile(): GlobalExposureProfile {
  return {
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: "World",
    breakdowns: { geography: { us: "1" } },
    ter: "0.002",
    trackedIndex: "MSCI World",
    hedgedToCurrency: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
}

function createForm(): FormData {
  const fd = new FormData();
  fd.set("mode", "create");
  fd.set("isin", "IE00B4L5Y983");
  fd.set("displayName", "World");
  fd.set("breakdowns", JSON.stringify({ geography: { us: "1" } }));
  return fd;
}

describe("guardAdmin is the first line of every verb (hostile per verb)", () => {
  const verbs: Array<[string, () => Promise<unknown>]> = [
    ["save", () => saveCatalogProfileAction({ status: "idle" }, createForm())],
    [
      "rekey",
      () => {
        const fd = new FormData();
        fd.set("from-isin", "IE00B4L5Y983");
        fd.set("to-isin", "US9229087690");
        return rekeyCatalogProfileAction({ status: "idle" }, fd);
      },
    ],
    [
      "delete",
      () => {
        const fd = new FormData();
        fd.set("isin", "IE00B4L5Y983");
        return deleteCatalogProfileAction({ status: "idle" }, fd);
      },
    ],
  ];

  for (const [name, run] of verbs) {
    it(`${name}: a non-admin session 404s and never opens the store`, async () => {
      asNonAdmin();
      await expect(run()).rejects.toMatchObject(NOT_FOUND);
      expect(withControlPlaneStore).not.toHaveBeenCalled();
    });

    it(`${name}: empty WORTHLINE_ADMIN_EMAIL 404s and never opens the store`, async () => {
      asAdmin();
      process.env.WORTHLINE_ADMIN_EMAIL = "";
      await expect(run()).rejects.toMatchObject(NOT_FOUND);
      expect(withControlPlaneStore).not.toHaveBeenCalled();
    });
  }
});

describe("saveCatalogProfileAction", () => {
  it("creates a profile for the admin and returns the persisted record", async () => {
    asAdmin();
    storeSpies.create.mockResolvedValueOnce(sampleProfile());

    const result = await saveCatalogProfileAction({ status: "idle" }, createForm());

    expect(storeSpies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ isin: "IE00B4L5Y983" }),
        breakdowns: { geography: { us: "1" } },
      }),
    );
    expect(result).toMatchObject({ status: "saved", previousKey: null });
  });

  it("updates (not creates) when mode=update", async () => {
    asAdmin();
    storeSpies.update.mockResolvedValueOnce(sampleProfile());
    const fd = createForm();
    fd.set("mode", "update");

    const result = await saveCatalogProfileAction({ status: "idle" }, fd);

    expect(storeSpies.update).toHaveBeenCalledTimes(1);
    expect(storeSpies.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "saved" });
  });

  it("surfaces a domain/store error as { status: error } instead of throwing", async () => {
    asAdmin();
    storeSpies.create.mockRejectedValueOnce(
      new Error("Global exposure profile identity already exists."),
    );

    const result = await saveCatalogProfileAction({ status: "idle" }, createForm());

    expect(result).toEqual({
      status: "error",
      message: "Global exposure profile identity already exists.",
    });
  });

  it("drops blank weights before they reach the domain", async () => {
    asAdmin();
    storeSpies.create.mockResolvedValueOnce(sampleProfile());
    const fd = createForm();
    fd.set("breakdowns", JSON.stringify({ geography: { us: "0.6", emerging: "" } }));

    await saveCatalogProfileAction({ status: "idle" }, fd);

    expect(storeSpies.create).toHaveBeenCalledWith(
      expect.objectContaining({ breakdowns: { geography: { us: "0.6" } } }),
    );
  });

  it("carries the sector vector (% of equity) through to the store (S4)", async () => {
    asAdmin();
    storeSpies.create.mockResolvedValueOnce(sampleProfile());
    const fd = createForm();
    fd.set(
      "breakdowns",
      JSON.stringify({
        assetClass: { equity: "1" },
        sector: { information_technology: "0.3", financials: "0.2", energy: "" },
      }),
    );

    await saveCatalogProfileAction({ status: "idle" }, fd);

    expect(storeSpies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        breakdowns: {
          assetClass: { equity: "1" },
          sector: { information_technology: "0.3", financials: "0.2" },
        },
      }),
    );
  });
});

describe("rekeyCatalogProfileAction", () => {
  it("rekeys and returns the old key so the client can follow the selection", async () => {
    asAdmin();
    storeSpies.rekey.mockResolvedValueOnce({
      ...sampleProfile(),
      identity: { kind: "isin", isin: "US9229087690" },
    });
    const fd = new FormData();
    fd.set("from-isin", "IE00B4L5Y983");
    fd.set("to-isin", "US9229087690");

    const result = await rekeyCatalogProfileAction({ status: "idle" }, fd);

    expect(storeSpies.rekey).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "saved", previousKey: "IE00B4L5Y983" });
  });
});

describe("deleteCatalogProfileAction", () => {
  it("deletes and returns the removed identity key", async () => {
    asAdmin();
    storeSpies.delete.mockResolvedValueOnce(undefined);
    const fd = new FormData();
    fd.set("isin", "IE00B4L5Y983");

    const result = await deleteCatalogProfileAction({ status: "idle" }, fd);

    expect(storeSpies.delete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "deleted", identityKey: "IE00B4L5Y983" });
  });
});
