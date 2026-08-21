/**
 * The traspaso screen's server action (#1480, S3 of PRD #1393): one submit, one
 * pair — and, when the destination does not exist yet, one holding created on the
 * way in without leaving the screen.
 *
 * What it drives, and why through the action rather than the gate. The gate's own
 * suite (`packages/db/src/commands/investment-transfer.test.ts`) already owns
 * "both or neither". What only this level can answer is whether the FORM reaches it
 * intact: the fields as typed in es-ES, the destination that has to be created
 * first, the idempotency key that stops a double click from writing two pairs
 * (#1394), and the refusals landing back on the ficha as a message instead of a
 * broken screen.
 *
 * Prior art: `record-operation-action.test.ts`.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { derivePosition, multiplyToMinor } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { recordTransferAction } from "./transfer-action";

const ORIGIN = "origen";
const DESTINATION = "destino";
const DATE = "2026-08-14";
const FICHA = `/patrimonio/${ORIGIN}/editar`;

/**
 * Jorge's shape of traspaso: a plan holding 100 participaciones bought at 10 €
 * (1.000 € of cost), worth 12 € the day the capital leaves, and a destination plan
 * quoted at 14,50 € that day.
 */
async function seed({ withDestination = true } = {}): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: ORIGIN,
    instrument: "pension_plan",
    liquidityTier: "term-locked",
    name: "Indexado PP",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  if (withDestination) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: DESTINATION,
      instrument: "pension_plan",
      liquidityTier: "term-locked",
      name: "Cartera Permanente PP",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
  }
  await store.command.recordInvestmentOperation(
    {
      assetId: ORIGIN,
      currency: "EUR",
      executedAt: "2025-01-15",
      feesMinor: 0,
      id: "op_compra",
      kind: "buy",
      pricePerUnit: "10",
      units: "100",
    },
    { today: "2026-08-21" },
  );
  return store;
}

function transferForm(
  over: Partial<Record<string, string>> = {},
  submissionId?: string,
): FormData {
  const fd = new FormData();
  fd.set("currentUrl", FICHA);
  fd.set("destinationAssetId", DESTINATION);
  fd.set("executedAt", DATE);
  fd.set("portion", "amount");
  fd.set("amount", "739,22");
  fd.set("originPricePerUnit", "12,00");
  fd.set("destinationPricePerUnit", "14,50");
  for (const [key, value] of Object.entries(over)) fd.set(key, value ?? "");
  if (submissionId !== undefined) fd.set("submissionId", submissionId);
  return fd;
}

/**
 * A redirect URL as a human reads it: `errorRedirectUrl` builds a query string, so
 * the message's spaces arrive as `+` and `decodeURIComponent` alone leaves them.
 */
function readable(redirect: string): string {
  return decodeURIComponent(redirect.replace(/\+/g, " "));
}

/** Run the action and return its redirect URL. */
async function submit(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await recordTransferAction(ORIGIN, fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

async function positionOf(store: WorthlineStore, assetId: string) {
  return derivePosition(await store.operations.readOperations(assetId), {
    assetId,
    currency: "EUR",
  });
}

describe("recordTransferAction — one screen, one submit", () => {
  test("writes the pair, tied by one transferId, from the fields as typed", async () => {
    const store = await seed();

    expect(await submit(transferForm(), store)).toContain("ok=transfer_recorded");

    const [, out] = await store.operations.readOperations(ORIGIN);
    const [incoming] = await store.operations.readOperations(DESTINATION);

    // 739,22 € ÷ 12 € and ÷ 14,50 €, each cut at the six decimals the app can read
    // back (#1395). Neither figure was typed.
    expect(out).toMatchObject({
      executedAt: DATE,
      kind: "transfer_out",
      units: "61.601667",
    });
    expect(incoming).toMatchObject({
      executedAt: DATE,
      kind: "transfer_in",
      // The acquisition cost that travels: the same proportion the fold removes.
      transferCostMinor: 61_602,
      units: "50.98069",
    });
    expect(out?.transferId).toBe(incoming?.transferId);
    expect(out?.transferId).toBeTruthy();
  });

  test("the origin's realized P/L does not move, and the capital does not vanish", async () => {
    const store = await seed();
    const before = await positionOf(store, ORIGIN);
    const valueBefore = multiplyToMinor(before.currentUnits, "12.00");

    await submit(transferForm(), store);

    const origin = await positionOf(store, ORIGIN);
    const destination = await positionOf(store, DESTINATION);

    // A traspaso is not a sale: nothing is realized, whatever the VL did (ADR 0082).
    expect(origin.realizedPnl.amountMinor).toBe(0);
    expect(before.realizedPnl.amountMinor).toBe(0);
    // The cost basis MOVES rather than disappearing — the destination inherits it.
    expect(origin.costBasis.amountMinor + destination.costBasis.amountMinor).toBe(
      before.costBasis.amountMinor,
    );

    // No step in the curve: valued at each side's own VL on the transfer date, the
    // two holdings are worth what the one holding was worth. The few cents of drift
    // are the six-decimal cut of #1395, not a hole.
    const valueAfter =
      multiplyToMinor(origin.currentUnits, "12.00") +
      multiplyToMinor(destination.currentUnits, "14.50");
    expect(Math.abs(valueAfter - valueBefore)).toBeLessThanOrEqual(10);
  });

  test("«todo» liquidates the origin exactly — no phantom millionth left behind", async () => {
    const store = await seed();

    await submit(transferForm({ amount: "", portion: "all" }), store);

    expect((await positionOf(store, ORIGIN)).currentUnits).toBe("0");
    expect((await positionOf(store, DESTINATION)).currentUnits).toBe("82.758621");
  });

  test("the two halves may differ in importe — 739,22 out, 740,72 in", async () => {
    const store = await seed();

    await submit(transferForm({ destinationAmount: "740,72" }), store);

    const [incoming] = await store.operations.readOperations(DESTINATION);
    // 740,72 ÷ 14,50 — the destination gets the units ITS amount buys, and the
    // origin still loses only what left.
    expect(incoming).toMatchObject({ units: "51.084138" });
    const [, out] = await store.operations.readOperations(ORIGIN);
    expect(out).toMatchObject({ units: "61.601667" });
  });

  test("two submits of the same submissionId leave ONE pair (#1394)", async () => {
    const store = await seed();
    const key = "3c1f5a7b9d2e4f6a8b0c1d2e3f4a5b6c";

    expect(await submit(transferForm({}, key), store)).toContain("ok=");
    expect(await submit(transferForm({}, key), store)).toContain("ok=");

    expect(await store.operations.readOperations(ORIGIN)).toHaveLength(2);
    expect(await store.operations.readOperations(DESTINATION)).toHaveLength(1);
  });

  test("two DIFFERENT submissions both persist — a split traspaso is legitimate", async () => {
    const store = await seed();

    await submit(transferForm({ amount: "100,00" }, "aaaa1111"), store);
    await submit(transferForm({ amount: "100,00" }, "bbbb2222"), store);

    expect(await store.operations.readOperations(DESTINATION)).toHaveLength(2);
  });
});

describe("recordTransferAction — a destination created on the way in", () => {
  test("creates the holding and lands the traspaso in it, in one submit", async () => {
    const store = await seed({ withDestination: false });

    const redirect = await submit(
      transferForm({
        destinationAssetId: "__new__",
        newDestinationIsin: "ES0173894017",
        newDestinationName: "Value PP",
      }),
      store,
    );
    expect(redirect).toContain("ok=transfer_recorded");

    const created = (await store.assets.readAssets()).find(
      (asset) => asset.name === "Value PP",
    );
    expect(created).toBeTruthy();
    // The new holding is the same kind of thing as the origin and belongs to the
    // same people: the capital only moved.
    expect(created?.ownership).toEqual([{ memberId: "mJ", shareBps: 10_000 }]);
    expect(created?.instrument).toBe("pension_plan");

    const investment = await store.assets.readInvestmentAssetById(created?.id ?? "");
    expect(investment).toMatchObject({
      isin: "ES0173894017",
      // Nobody will quote a hand-created plan, so the VL just declared is its price
      // — otherwise the holding would land worth 0 €.
      manualPricePerUnit: "14.50",
    });

    const [incoming] = await store.operations.readOperations(created?.id ?? "");
    expect(incoming).toMatchObject({ kind: "transfer_in", units: "50.98069" });
  });

  test("a replayed submit does not create a second holding", async () => {
    const store = await seed({ withDestination: false });
    const fields = { destinationAssetId: "__new__", newDestinationName: "Value PP" };

    await submit(transferForm(fields, "cccc3333"), store);
    await submit(transferForm(fields, "cccc3333"), store);

    expect(
      (await store.assets.readAssets()).filter((asset) => asset.name === "Value PP"),
    ).toHaveLength(1);
  });

  test("an impossible importe leaves no empty holding behind", async () => {
    const store = await seed({ withDestination: false });
    const assetsBefore = (await store.assets.readAssets()).length;

    const redirect = readable(
      await submit(
        transferForm({
          amount: "5.000,00",
          destinationAssetId: "__new__",
          newDestinationName: "Value PP",
        }),
        store,
      ),
    );

    expect(redirect).toContain("traspasar todo");
    // The figures are judged before the holding is created: a refused traspaso must
    // not leave a 0 € plan in the list for the user to go and delete.
    expect((await store.assets.readAssets()).length).toBe(assetsBefore);
  });

  test("a destination with no name is refused BEFORE anything is created", async () => {
    const store = await seed({ withDestination: false });
    const assetsBefore = (await store.assets.readAssets()).length;

    const redirect = await submit(
      transferForm({ destinationAssetId: "__new__", newDestinationName: "" }),
      store,
    );

    expect(redirect).toContain("error=");
    expect(readable(redirect)).toContain("nombre");
    expect((await store.assets.readAssets()).length).toBe(assetsBefore);
  });
});

describe("recordTransferAction — refusals land on the form, not on a broken screen", () => {
  test("an importe above the position is refused, and offers «todo»", async () => {
    const store = await seed();

    const redirect = await submit(transferForm({ amount: "5.000,00" }), store);

    expect(redirect).toContain(FICHA);
    expect(readable(redirect)).toContain("traspasar todo");
    // Nothing was written: not the outgoing half, not the incoming one.
    expect(await store.operations.readOperations(ORIGIN)).toHaveLength(1);
    expect(await store.operations.readOperations(DESTINATION)).toHaveLength(0);
  });

  test("the refusal round-trips what was typed, so nothing has to be re-entered", async () => {
    const store = await seed();

    const redirect = readable(await submit(transferForm({ amount: "5.000,00" }), store));

    expect(redirect).toContain("v_amount=5.000,00");
    expect(redirect).toContain("v_destinationPricePerUnit=14,50");
    expect(redirect).toContain("form=transfer");
  });

  test("a blank importe is named as such instead of writing a 0 € traspaso", async () => {
    const store = await seed();

    const redirect = readable(await submit(transferForm({ amount: "" }), store));

    expect(redirect).toContain("importe");
    expect(await store.operations.readOperations(DESTINATION)).toHaveLength(0);
  });

  test("traspasar onto the holding itself is refused", async () => {
    const store = await seed();

    const redirect = readable(
      await submit(transferForm({ destinationAssetId: ORIGIN }), store),
    );

    expect(redirect).toContain("misma inversión");
  });
});
