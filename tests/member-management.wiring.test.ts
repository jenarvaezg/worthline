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
} from "@web/ajustes/actions";
import { catchRedirect, fd } from "./helpers";

// ------------------------------------------------------------- test fixtures --

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

async function setupStore() {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_ana", name: "Ana" }],
    mode: "individual",
  });
  return store;
}

// ================================================================ createMember

describe("createMemberAction wiring", () => {
  test("happy path: creates member and redirects to ok", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      createMemberAction(fd({ name: "Jose" }, "/ajustes"), store),
    );

    expect(url).toContain("ok=saved");

    const ws = (await store.workspace.readWorkspace())!;
    const names = ws.members.map((m) => m.name);
    expect(names).toContain("Jose");
  });

  test("blank name: error redirect, store unchanged", async () => {
    await setupStore();
    const before = (await store.workspace.readWorkspace())!.members.length;

    const url = await catchRedirect(() =>
      createMemberAction(fd({ name: "" }, "/ajustes"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/obligatorio/i);
    expect((await store.workspace.readWorkspace())!.members.length).toBe(before);
  });
});

// ================================================================ updateMember

describe("updateMemberAction wiring", () => {
  test("happy path: updates member name", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      updateMemberAction(fd({ id: "member_ana", name: "Ana García" }, "/ajustes"), store),
    );

    expect(url).toContain("ok=saved");
    const ws = (await store.workspace.readWorkspace())!;
    expect(ws.members.find((m) => m.id === "member_ana")?.name).toBe("Ana García");
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      updateMemberAction(fd({ id: "", name: "Ana García" }, "/ajustes"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
  });

  test("blank name: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      updateMemberAction(fd({ id: "member_ana", name: "" }, "/ajustes"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/obligatorio/i);
    // Name unchanged
    expect(
      (await store.workspace.readWorkspace())!.members.find((m) => m.id === "member_ana")
        ?.name,
    ).toBe("Ana");
  });
});

// ================================================================ disableMember

describe("disableMemberAction wiring", () => {
  test("happy path: member is disabled", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      disableMemberAction(fd({ id: "member_ana" }, "/ajustes"), store),
    );

    expect(url).toContain("ok=saved");
    const member = (await store.workspace.readWorkspace())!.members.find(
      (m) => m.id === "member_ana",
    );
    expect(member?.disabledAt).toBeTruthy();
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      disableMemberAction(fd({ id: "" }, "/ajustes"), store),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/identificador/i);
    // Member still active
    expect(
      (await store.workspace.readWorkspace())!.members.find((m) => m.id === "member_ana")
        ?.disabledAt,
    ).toBeFalsy();
  });
});

// ============================================================= reactivateMember

describe("reactivateMemberAction wiring", () => {
  test("happy path: reactivates a disabled member", async () => {
    await setupStore();
    await store.workspace.disableMember("member_ana", new Date().toISOString());

    const url = await catchRedirect(() =>
      reactivateMemberAction(fd({ id: "member_ana" }, "/ajustes"), store),
    );

    expect(url).toContain("ok=saved");
    const member = (await store.workspace.readWorkspace())!.members.find(
      (m) => m.id === "member_ana",
    );
    expect(member?.disabledAt).toBeFalsy();
  });

  test("missing id: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      reactivateMemberAction(fd({ id: "" }, "/ajustes"), store),
    );

    expect(url).toContain("error=");
  });
});

// ============================================================= saveFireConfig

describe("saveFireConfigAction wiring", () => {
  test("happy path: saves FIRE config and redirects with fire_saved", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            scopeId: "household",
            monthlySpending: "2000",
            safeWithdrawalRate: "4",
            expectedRealReturn: "5",
            targetRetirementAge: "55",
          },
          "/ajustes",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=fire_saved");
    const configs = await store.readFireConfig();
    expect(configs["household"]).toBeDefined();
    expect(configs["household"]!.monthlySpendingMinor).toBe(200_000);
  });

  test("zero monthly spending: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            monthlySpending: "0",
            safeWithdrawalRate: "4",
            expectedRealReturn: "5",
          },
          "/ajustes",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    // URLSearchParams encodes spaces as "+", which decodeURIComponent keeps.
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/gasto mensual/i);
  });

  test("invalid withdrawal rate: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            monthlySpending: "2000",
            safeWithdrawalRate: "0",
            expectedRealReturn: "5",
          },
          "/ajustes",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/tasa/i);
  });

  test("invalid scope id: error redirect and no orphan FIRE config", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            scopeId: "ghost_scope",
            monthlySpending: "2000",
            safeWithdrawalRate: "4",
            expectedRealReturn: "5",
          },
          "/ajustes",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/scope/i);
    expect((await store.readFireConfig()).ghost_scope).toBeUndefined();
  });
});

// ======================================================= retractWarningOverride

describe("retractWarningOverrideAction wiring", () => {
  test("happy path: removes a persisted warning override", async () => {
    await setupStore();
    // Seed an override
    await store.acknowledgeWarning("zero_value_asset", "asset_test_1");
    expect(await store.readWarningOverrides()).toHaveLength(1);

    const url = await catchRedirect(() =>
      retractWarningOverrideAction(
        fd({ code: "zero_value_asset", entityId: "asset_test_1" }, "/ajustes"),
        store,
      ),
    );

    expect(url).toContain("ok=saved");
    expect(await store.readWarningOverrides()).toHaveLength(0);
  });

  test("missing code: error redirect, override untouched", async () => {
    await setupStore();
    await store.acknowledgeWarning("zero_value_asset", "asset_test_1");

    const url = await catchRedirect(() =>
      retractWarningOverrideAction(
        fd({ code: "", entityId: "asset_test_1" }, "/ajustes"),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(await store.readWarningOverrides()).toHaveLength(1);
  });

  test("missing entityId: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      retractWarningOverrideAction(
        fd({ code: "zero_value_asset", entityId: "" }, "/ajustes"),
        store,
      ),
    );

    expect(url).toContain("error=");
  });
});
