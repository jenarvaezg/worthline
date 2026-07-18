/**
 * Action-level tests for the balance-anchor actions (PRD #1112 S1 pilot) —
 * add / update / delete a declared balance on a revolving/informal debt
 * (ADR 0020 / 0025). Before this slice these three actions had NO tests through
 * their interface; here they run against an in-memory store, asserting the debt
 * seam's ripple lands on /historico's snapshots, the R9 model guard, validation
 * errors, demo write-gating, and the duplicate-date translation the combinator
 * now brings them (#692).
 */

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addBalanceAnchorAction,
  deleteBalanceAnchorAction,
  updateBalanceAnchorAction,
} from "./actions";

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

const TODAY = "2026-07-02";
const CLOCK: Clock = fixedClock(TODAY);
const MEMBER_ID = "mJ";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

async function runAction(
  action: (fd: FormData, ...args: unknown[]) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await action(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots()).find((s) => s.dateKey === dateKey)?.debts
    .amountMinor;
}

/** Seed a revolving card (the `anchorable` model) so balance anchors apply. */
async function seedRevolvingCard(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "cash",
  });
  await store.liabilities.createLiability({
    balanceMinor: 1_000_00,
    currency: "EUR",
    id: "card",
    name: "Tarjeta",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "debt",
  });
  await store.liabilities.setDebtModel("card", "revolving");
  return store;
}

async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  return store;
}

describe("addBalanceAnchorAction", () => {
  test("persists a past anchor and ripples a snapshot carrying the declared balance", async () => {
    const store = await seedRevolvingCard();

    const url = await runAction(
      addBalanceAnchorAction,
      form({
        currentUrl: "/patrimonio/card/editar",
        id: "card",
        anchorDate: "2026-05-01",
        balance: "3.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("balance_anchor_added");

    const anchors = await store.liabilities.readBalanceAnchors("card");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      anchorDate: "2026-05-01",
      balanceMinor: 3_000_00,
    });
    // The anchor backfilled a snapshot at its date carrying the 3000.00 balance.
    expect(await debtsAt(store, "2026-05-01")).toBe(3_000_00);

    store.close();
  });

  test("rejects an invalid balance (0) without persisting anything", async () => {
    const store = await seedRevolvingCard();

    const url = await runAction(
      addBalanceAnchorAction,
      form({ id: "card", anchorDate: "2026-05-01", balance: "0" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceAnchors("card")).toHaveLength(0);

    store.close();
  });

  test("rejects a future anchor date without persisting anything", async () => {
    const store = await seedRevolvingCard();

    const url = await runAction(
      addBalanceAnchorAction,
      form({ id: "card", anchorDate: "2026-07-03", balance: "3.000,00" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceAnchors("card")).toHaveLength(0);

    store.close();
  });

  test("refuses an amortizable debt — balances only apply to revolving/informal (R9)", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      addBalanceAnchorAction,
      form({ id: "mortgage", anchorDate: "2026-05-01", balance: "3.000,00" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceAnchors("mortgage")).toHaveLength(0);

    store.close();
  });

  test("re-submitting the SAME anchor date returns a friendly error, not a 500 (#692)", async () => {
    const store = await seedRevolvingCard();
    const sameDate = { id: "card", anchorDate: "2026-05-01", balance: "3.000,00" };

    const first = await runAction(addBalanceAnchorAction, form(sameDate), store, CLOCK);
    expect(first).toContain("balance_anchor_added");

    const second = await runAction(
      addBalanceAnchorAction,
      form({ ...sameDate, balance: "2.500,00" }),
      store,
      CLOCK,
    );
    expect(second).toContain("error=");

    // The rejected insert rolled back — still exactly the first anchor.
    const anchors = await store.liabilities.readBalanceAnchors("card");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.balanceMinor).toBe(3_000_00);

    store.close();
  });

  test("blocks the mutation in demo mode and leaves the store untouched", async () => {
    const store = await seedRevolvingCard();
    mockPersonaCookie = "familia";

    const url = await runAction(
      addBalanceAnchorAction,
      form({
        currentUrl: "/patrimonio/card/editar",
        id: "card",
        anchorDate: "2026-05-01",
        balance: "3.000,00",
      }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readBalanceAnchors("card")).toHaveLength(0);

    store.close();
  });
});

describe("updateBalanceAnchorAction", () => {
  async function seedWithAnchor(): Promise<{ store: WorthlineStore; anchorId: string }> {
    const store = await seedRevolvingCard();
    await runAction(
      addBalanceAnchorAction,
      form({ id: "card", anchorDate: "2026-05-01", balance: "3.000,00" }),
      store,
      CLOCK,
    );
    const anchorId = (await store.liabilities.readBalanceAnchors("card"))[0]!.id;
    return { store, anchorId };
  }

  test("updates the balance and re-ripples the snapshot at its date", async () => {
    const { store, anchorId } = await seedWithAnchor();

    const url = await runAction(
      updateBalanceAnchorAction,
      form({ id: "card", anchorId, anchorDate: "2026-05-01", balance: "2.500,00" }),
      store,
      CLOCK,
    );
    expect(url).toContain("balance_anchor_saved");

    expect((await store.liabilities.readBalanceAnchors("card"))[0]!.balanceMinor).toBe(
      2_500_00,
    );
    expect(await debtsAt(store, "2026-05-01")).toBe(2_500_00);

    store.close();
  });

  test("missing anchorId redirects with the missing-id message, no change", async () => {
    const { store } = await seedWithAnchor();

    const url = await runAction(
      updateBalanceAnchorAction,
      form({ id: "card", anchorDate: "2026-05-01", balance: "2.500,00" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(
      "Identificador del saldo no encontrado.",
    );
    expect((await store.liabilities.readBalanceAnchors("card"))[0]!.balanceMinor).toBe(
      3_000_00,
    );

    store.close();
  });

  test("an unknown anchorId reports not-found without touching the existing anchor", async () => {
    const { store } = await seedWithAnchor();

    const url = await runAction(
      updateBalanceAnchorAction,
      form({
        id: "card",
        anchorId: "ghost",
        anchorDate: "2026-05-01",
        balance: "2.500,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect((await store.liabilities.readBalanceAnchors("card"))[0]!.balanceMinor).toBe(
      3_000_00,
    );

    store.close();
  });

  test("rejects an invalid balance without changing the anchor", async () => {
    const { store, anchorId } = await seedWithAnchor();

    const url = await runAction(
      updateBalanceAnchorAction,
      form({ id: "card", anchorId, anchorDate: "2026-05-01", balance: "0" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect((await store.liabilities.readBalanceAnchors("card"))[0]!.balanceMinor).toBe(
      3_000_00,
    );

    store.close();
  });

  test("blocks the mutation in demo mode", async () => {
    const { store, anchorId } = await seedWithAnchor();
    mockPersonaCookie = "familia";

    const url = await runAction(
      updateBalanceAnchorAction,
      form({
        currentUrl: "/patrimonio/card/editar",
        id: "card",
        anchorId,
        anchorDate: "2026-05-01",
        balance: "2.500,00",
      }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect((await store.liabilities.readBalanceAnchors("card"))[0]!.balanceMinor).toBe(
      3_000_00,
    );

    store.close();
  });
});

describe("deleteBalanceAnchorAction", () => {
  async function seedWithAnchor(): Promise<{ store: WorthlineStore; anchorId: string }> {
    const store = await seedRevolvingCard();
    await runAction(
      addBalanceAnchorAction,
      form({ id: "card", anchorDate: "2026-05-01", balance: "3.000,00" }),
      store,
      CLOCK,
    );
    const anchorId = (await store.liabilities.readBalanceAnchors("card"))[0]!.id;
    return { store, anchorId };
  }

  test("removes the anchor and re-ripples the curve off its date", async () => {
    const { store, anchorId } = await seedWithAnchor();
    expect(await debtsAt(store, "2026-05-01")).toBe(3_000_00);

    const url = await runAction(
      deleteBalanceAnchorAction,
      form({ id: "card", anchorId }),
      store,
      CLOCK,
    );
    expect(url).toContain("balance_anchor_deleted");
    expect(await store.liabilities.readBalanceAnchors("card")).toHaveLength(0);

    store.close();
  });

  test("an unknown anchorId reports not-found", async () => {
    const { store } = await seedWithAnchor();

    const url = await runAction(
      deleteBalanceAnchorAction,
      form({ id: "card", anchorId: "ghost" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceAnchors("card")).toHaveLength(1);

    store.close();
  });

  test("missing anchorId redirects with the missing-id message", async () => {
    const { store } = await seedWithAnchor();

    const url = await runAction(
      deleteBalanceAnchorAction,
      form({ id: "card" }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(
      "Identificador del saldo no encontrado.",
    );
    expect(await store.liabilities.readBalanceAnchors("card")).toHaveLength(1);

    store.close();
  });

  test("blocks the mutation in demo mode", async () => {
    const { store, anchorId } = await seedWithAnchor();
    mockPersonaCookie = "familia";

    const url = await runAction(
      deleteBalanceAnchorAction,
      form({ currentUrl: "/patrimonio/card/editar", id: "card", anchorId }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readBalanceAnchors("card")).toHaveLength(1);

    store.close();
  });
});
