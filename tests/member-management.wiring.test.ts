/**
 * Wiring suite: member management + FIRE config + warning override retract actions
 * (ajustes/actions.ts).
 *
 * Each action is driven through its real FormData interface against an isolated
 * in-memory store.  next/cache is stubbed; NEXT_REDIRECT digest is parsed.
 */

import { vi, describe, test, expect, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import {
  createMemberAction,
  updateMemberAction,
  disableMemberAction,
  reactivateMemberAction,
  saveFireConfigAction,
  retractWarningOverrideAction,
} from "../apps/web/app/ajustes/actions";

// ------------------------------------------------------------------ helpers --

function catchRedirect(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      throw new Error("Expected redirect but action returned normally");
    },
    (err: unknown) => {
      if (err instanceof Error && (err.message === "NEXT_REDIRECT" || "digest" in err)) {
        const digest = (err as { digest?: string }).digest ?? "";
        const parts = digest.split(";");
        return parts[2] ?? digest;
      }
      throw err;
    },
  );
}

function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  form.set("currentUrl", "/ajustes");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

function setupStore() {
  store = createInMemoryStore();
  store.initializeWorkspace({
    members: [{ id: "member_ana", name: "Ana" }],
    mode: "individual",
  });
  return store;
}

// ================================================================ createMember

describe("createMemberAction wiring", () => {
  test("happy path: creates member and redirects to ok", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      createMemberAction(fd({ name: "Jose" }), store),
    );

    expect(url).toContain("ok=saved");

    const ws = store.readWorkspace()!;
    const names = ws.members.map((m) => m.name);
    expect(names).toContain("Jose");
  });

  test("blank name: error redirect, store unchanged", async () => {
    setupStore();
    const before = store.readWorkspace()!.members.length;

    const url = await catchRedirect(() =>
      createMemberAction(fd({ name: "" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/obligatorio/i);
    expect(store.readWorkspace()!.members.length).toBe(before);
  });
});

// ================================================================ updateMember

describe("updateMemberAction wiring", () => {
  test("happy path: updates member name", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      updateMemberAction(fd({ id: "member_ana", name: "Ana García" }), store),
    );

    expect(url).toContain("ok=saved");
    const ws = store.readWorkspace()!;
    expect(ws.members.find((m) => m.id === "member_ana")?.name).toBe("Ana García");
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      updateMemberAction(fd({ id: "", name: "Ana García" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("blank name: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      updateMemberAction(fd({ id: "member_ana", name: "" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/obligatorio/i);
    // Name unchanged
    expect(store.readWorkspace()!.members.find((m) => m.id === "member_ana")?.name).toBe("Ana");
  });
});

// ================================================================ disableMember

describe("disableMemberAction wiring", () => {
  test("happy path: member is disabled", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      disableMemberAction(fd({ id: "member_ana" }), store),
    );

    expect(url).toContain("ok=saved");
    const member = store.readWorkspace()!.members.find((m) => m.id === "member_ana");
    expect(member?.disabledAt).toBeTruthy();
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      disableMemberAction(fd({ id: "" }), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
    // Member still active
    expect(store.readWorkspace()!.members.find((m) => m.id === "member_ana")?.disabledAt).toBeFalsy();
  });
});

// ============================================================= reactivateMember

describe("reactivateMemberAction wiring", () => {
  test("happy path: reactivates a disabled member", async () => {
    setupStore();
    store.disableMember("member_ana", new Date().toISOString());

    const url = await catchRedirect(() =>
      reactivateMemberAction(fd({ id: "member_ana" }), store),
    );

    expect(url).toContain("ok=saved");
    const member = store.readWorkspace()!.members.find((m) => m.id === "member_ana");
    expect(member?.disabledAt).toBeFalsy();
  });

  test("missing id: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      reactivateMemberAction(fd({ id: "" }), store),
    );

    expect(url).toContain("error=");
  });
});

// ============================================================= saveFireConfig

describe("saveFireConfigAction wiring", () => {
  test("happy path: saves FIRE config and redirects with fire_saved", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd({
          scopeId: "household",
          monthlySpending: "2000",
          safeWithdrawalRate: "4",
          expectedRealReturn: "5",
          targetRetirementAge: "55",
        }),
        store,
      ),
    );

    expect(url).toContain("ok=fire_saved");
    const configs = store.readFireConfig();
    expect(configs["household"]).toBeDefined();
    expect(configs["household"]!.monthlySpendingMinor).toBe(200_000);
  });

  test("zero monthly spending: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd({
          monthlySpending: "0",
          safeWithdrawalRate: "4",
          expectedRealReturn: "5",
        }),
        store,
      ),
    );

    expect(url).toContain("error=");
    // URLSearchParams encodes spaces as "+", which decodeURIComponent keeps.
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/gasto mensual/i);
  });

  test("invalid withdrawal rate: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd({
          monthlySpending: "2000",
          safeWithdrawalRate: "0",
          expectedRealReturn: "5",
        }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/tasa/i);
  });
});

// ======================================================= retractWarningOverride

describe("retractWarningOverrideAction wiring", () => {
  test("happy path: removes a persisted warning override", async () => {
    setupStore();
    // Seed an override
    store.acknowledgeWarning("zero_value_asset", "asset_test_1");
    expect(store.readWarningOverrides()).toHaveLength(1);

    const url = await catchRedirect(() =>
      retractWarningOverrideAction(
        fd({ code: "zero_value_asset", entityId: "asset_test_1" }),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    expect(store.readWarningOverrides()).toHaveLength(0);
  });

  test("missing code: error redirect, override untouched", async () => {
    setupStore();
    store.acknowledgeWarning("zero_value_asset", "asset_test_1");

    const url = await catchRedirect(() =>
      retractWarningOverrideAction(
        fd({ code: "", entityId: "asset_test_1" }),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(store.readWarningOverrides()).toHaveLength(1);
  });

  test("missing entityId: error redirect", async () => {
    setupStore();

    const url = await catchRedirect(() =>
      retractWarningOverrideAction(
        fd({ code: "zero_value_asset", entityId: "" }),
        store,
      ),
    );

    expect(url).toContain("error=");
  });
});
