/**
 * The ficha's «Traer de otra entidad» server action (#1518): the second movilización
 * onto a holding this book already keeps.
 *
 * What only this level can answer. The gate's own suite
 * (`packages/db/src/commands/investment-transfer.test.ts`) already owns what an
 * external entry IS — one `transfer_in`, its own `transferId`, the declared cost and
 * seniority on the row. What this drives is whether the FORM reaches it intact: the
 * figures as typed in es-ES, the idempotency key that stops a double click from
 * booking the capital twice (#1394), the refusals landing on the ficha as a message,
 * and — the whole reason the ticket exists — that what lands is not a `buy`.
 *
 * Prior art: `transfer-action.test.ts`.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import {
  computeContributionAllowanceUsage,
  derivePosition,
  measureMonthlySavings,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { recordExternalEntryAction } from "./external-entry-action";

const HOLDING = "n5396";
const FICHA = `/patrimonio/${HOLDING}/editar`;

/** Jorge's Indexado Global PP, already on the book with a real purchase behind it. */
async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: HOLDING,
    instrument: "pension_plan",
    liquidityTier: "term-locked",
    name: "MyInvestor Indexado Global PP",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  await store.command.recordInvestmentOperation(
    {
      assetId: HOLDING,
      currency: "EUR",
      executedAt: "2025-11-15",
      feesMinor: 0,
      id: "op_aportacion",
      kind: "buy",
      pricePerUnit: "17",
      units: "10",
    },
    { today: "2026-01-31" },
  );
  return store;
}

/** Jorge's real 5-dic-2025 movilización: 4.979,55 € at a VL of 17,016775 €. */
function entryForm(
  over: Partial<Record<string, string>> = {},
  submissionId?: string,
): FormData {
  const fd = new FormData();
  fd.set("currentUrl", FICHA);
  fd.set("trAmount", "4979,55");
  fd.set("trPrice", "17,016775");
  fd.set("trDate", "2025-12-05");
  fd.set("trCost", "");
  fd.set("trSeniority", "");
  for (const [key, value] of Object.entries(over)) fd.set(key, value ?? "");
  if (submissionId !== undefined) fd.set("submissionId", submissionId);
  return fd;
}

function readable(redirect: string): string {
  return decodeURIComponent(redirect.replace(/\+/g, " "));
}

async function submit(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await recordExternalEntryAction(HOLDING, fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") return e.digest;
    throw err;
  }
}

async function entryOf(store: WorthlineStore) {
  const operations = await store.operations.readOperations(HOLDING);
  return operations.find((operation) => operation.kind === "transfer_in");
}

describe("recordExternalEntryAction — la movilización que llega a un holding que ya existe", () => {
  test("writes ONE transfer_in with its own transferId and no counterpart", async () => {
    const store = await seed();

    expect(await submit(entryForm(), store)).toContain("ok=external_entry_recorded");

    const entry = await entryOf(store);
    // 4.979,55 € ÷ 17,016775 €, cut at the six decimals the app reads back (#1395).
    expect(entry).toMatchObject({
      executedAt: "2025-12-05",
      kind: "transfer_in",
      // Blank cost = the importe that arrived: no latent gain nobody declared.
      transferCostMinor: 497_955,
      units: "292.625953",
    });
    expect(entry?.transferId).toBeTruthy();
    // Nothing else on the ledger carries that id — the outgoing half is MyInvestor's.
    const sharing = (await store.operations.readOperations(HOLDING)).filter(
      (operation) => operation.transferId === entry?.transferId,
    );
    expect(sharing).toHaveLength(1);
  });

  test("no consume cupo de aportación, y el ahorro de diciembre no se mueve", async () => {
    const store = await seed();

    await submit(entryForm(), store);
    const operations = await store.operations.readOperations(HOLDING);

    // The two figures the mislabelled `buy` corrupted for nine months (#1449, ADR
    // 0080). Only the 170 € aportación of noviembre is money Jorge put in.
    expect(
      computeContributionAllowanceUsage({
        allowance: {
          annualCapMinor: 150_000,
          holdingIds: [HOLDING],
          id: "cupo",
          label: "Planes de pensiones",
          scopeId: "mJ",
        },
        currency: "EUR",
        operations,
        todayISO: "2025-12-31",
      }).consumedMinor,
    ).toBe(17_000);
    expect(
      measureMonthlySavings(operations, { asOfDateKey: "2025-12-31", windowMonths: 1 })
        .netMinor,
    ).toBe(0);
  });

  test("el coste declarado entra íntegro en el costBasis, y no realiza plusvalía", async () => {
    const store = await seed();

    await submit(entryForm({ trCost: "4000,00" }), store);

    const position = derivePosition(await store.operations.readOperations(HOLDING), {
      assetId: HOLDING,
      currency: "EUR",
    });
    // 170 € of the aportación + 4.000 € declared. The 979,55 € of latent gain travel
    // as latent gain, which is what the entry is FOR.
    expect(position.costBasis.amountMinor).toBe(417_000);
    expect(position.realizedPnl.amountMinor).toBe(0);
  });

  test("una antigüedad declarada llega hasta la fila", async () => {
    const store = await seed();

    await submit(entryForm({ trSeniority: "2014-03-01" }), store);

    expect((await entryOf(store))?.transferSeniorityAt).toBe("2014-03-01");
  });

  test("sin antigüedad declarada la fila no inventa una", async () => {
    const store = await seed();

    await submit(entryForm(), store);

    expect((await entryOf(store))?.transferSeniorityAt).toBeUndefined();
  });

  test("una antigüedad posterior a la entrada se rechaza en la ficha, no en un 500", async () => {
    const store = await seed();

    const redirect = readable(
      await submit(entryForm({ trSeniority: "2026-01-01" }), store),
    );

    expect(redirect).toContain("form=externalEntry");
    expect(redirect).toContain("posterior al día en que entraron");
    // And nothing was written: a refused entry leaves the ledger as it was.
    expect(await entryOf(store)).toBeUndefined();
  });

  test("un VL de cero se rechaza con las palabras de la puerta", async () => {
    const store = await seed();

    const redirect = readable(await submit(entryForm({ trPrice: "0" }), store));

    expect(redirect).toContain("Necesito el valor liquidativo");
    expect(await entryOf(store)).toBeUndefined();
  });

  test("dos clics con la misma clave escriben UNA sola entrada (#1394)", async () => {
    const store = await seed();

    await submit(entryForm({}, "k-doble"), store);
    await submit(entryForm({}, "k-doble"), store);

    const entries = (await store.operations.readOperations(HOLDING)).filter(
      (operation) => operation.kind === "transfer_in",
    );
    expect(entries).toHaveLength(1);
  });

  test("los campos vuelven tecleados cuando la entrada se rechaza", async () => {
    const store = await seed();

    const redirect = readable(
      await submit(entryForm({ trCost: "4000,00", trPrice: "0" }), store),
    );

    // The cost is the figure the user had to look up in the old provider's paperwork;
    // losing it on a refusal sends him back to the statement.
    expect(redirect).toContain("trCost=4000,00");
    expect(redirect).toContain("trAmount=4979,55");
  });
});
