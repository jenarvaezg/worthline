/**
 * Wiring suite: the FIRE config action (objetivos/fire-config-actions.ts).
 *
 * The action moved here with its form (#1450): the assumptions are edited beside
 * the figures they govern, so the save redirects back to /objetivos. Driven through
 * its real FormData interface against an isolated in-memory store.
 */

import { saveFireConfigAction } from "@web/objetivos/fire-config-actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test, vi } from "vitest";
import { catchRedirect, fd } from "./helpers";

vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

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
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=fire_saved");
    const configs = await store.readFireConfig("2026-08-18");
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
          "/objetivos",
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
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/tasa/i);
  });

  // La declaración de #1460 viaja como casilla + `hidden`, así que el wiring la
  // ejercita como la manda el navegador: dos valores con el mismo nombre.
  test("unchecking the immobilized box stores the declaration", async () => {
    await setupStore();
    const form = fd(
      {
        scopeId: "household",
        monthlySpending: "2000",
        safeWithdrawalRate: "4",
        countImmobilized: "off",
      },
      "/objetivos",
    );

    const url = await catchRedirect(() => saveFireConfigAction(form, store));

    expect(url).toContain("ok=fire_saved");
    const config = (await store.readFireConfig("2026-08-18")).household;
    expect(config!.immobilizedCountsAsFireCapital).toBe(false);
  });

  test("a checked box saves the default declaration explicitly", async () => {
    await setupStore();
    const form = fd(
      {
        scopeId: "household",
        monthlySpending: "2000",
        safeWithdrawalRate: "4",
        countImmobilized: "off",
      },
      "/objetivos",
    );
    form.append("countImmobilized", "on");

    await catchRedirect(() => saveFireConfigAction(form, store));

    const config = (await store.readFireConfig("2026-08-18")).household;
    expect(config!.immobilizedCountsAsFireCapital).toBe(true);
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
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/scope/i);
    expect((await store.readFireConfig("2026-08-18")).ghost_scope).toBeUndefined();
  });
});
