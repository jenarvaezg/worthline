/**
 * What worthline finds in the book for the two funds of a traspaso paper (#1793,
 * decided with Jose after the live run of #1801): the model searched by the printed
 * names, found nothing and said neither fund existed. The app matches by identifier
 * instead, and says what it found — one, none or several — next to the paper.
 */

import type { ValidatedAttachment } from "@web/asistente/attachment-chat";
import { extractedDocumentSchema } from "@web/asistente/attachment-extraction-contract";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, it } from "vitest";

import {
  EMPTY_TRANSFER_BOOK,
  foundByWorthline,
  transferBookHoldings,
} from "./transfer-book";
import { readTransferBook } from "./transfer-identity";

// Real, public fund ISINs with a valid check digit; names and figures are invented.
const MUNDO = "IE00B4L5Y983";
const EMERGENTES = "IE00B5BMR087";

function paper(
  sides: {
    origin?: { isin?: string; dgsCode?: string };
    destination?: { isin?: string; dgsCode?: string };
  } = {},
): ValidatedAttachment {
  return {
    document: extractedDocumentSchema.parse({
      documentType: "transfer",
      transfer: {
        amount: 739.22,
        confirms: "redemption",
        currency: "EUR",
        date: "2026-08-14",
        destination: {
          name: "FONDO EMERGENTES EJEMPLO",
          ...(sides.destination ?? { isin: EMERGENTES }),
        },
        label: "REEMB.POR TRASPASO I",
        origin: { name: "FONDO MUNDO EJEMPLO", ...(sides.origin ?? { isin: MUNDO }) },
        units: 61.6,
      },
      warnings: [],
    }),
    fileName: "aviso-traspaso.pdf",
  };
}

interface Fund {
  id: string;
  name: string;
  isin?: string;
}

let store: WorthlineStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

async function book(funds: readonly Fund[]) {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jorge" }],
    mode: "individual",
  });
  for (const fund of funds) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: fund.id,
      instrument: "fund",
      name: fund.name,
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      ...(fund.isin ? { securityId: { kind: "isin" as const, value: fund.isin } } : {}),
    });
  }
  const ids = Object.fromEntries(
    (await store.agentView.readPublicIds())
      .filter((row) => row.entityType === "holding")
      .map((row) => [row.entityId, row.publicId]),
  ) as Record<string, string>;
  return { ids, store };
}

function transferOf(attachment: ValidatedAttachment) {
  if (attachment.document.documentType !== "transfer") throw new Error("not a transfer");
  return attachment.document.transfer;
}

describe("what worthline finds for each fund the paper names", () => {
  it("one holding: «en tu patrimonio», with its name and its id — inside a managed portfolio too", async () => {
    const { ids, store } = await book([
      { id: "mundo", isin: MUNDO, name: "Fondo Mundo" },
      { id: "emergentes", isin: EMERGENTES, name: "Fondo Emergentes" },
    ]);
    await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: [{ memberId: "mJ", shareBps: 10_000 }],
      memberHoldingIds: ["emergentes"],
      name: "Cartera Gestionada Ejemplo",
      scopeId: "household",
    });
    const attachment = paper();

    const found = foundByWorthline(
      transferOf(attachment),
      await readTransferBook(store, [attachment]),
    );

    expect(found).toEqual({
      destination: `en tu patrimonio: «Fondo Emergentes» (${ids["emergentes"]})`,
      origin: `en tu patrimonio: «Fondo Mundo» (${ids["mundo"]})`,
    });
  });

  it("no holding: «no está en tu patrimonio», and the destination's route is an alta without opening, then the traspaso", async () => {
    const { store } = await book([{ id: "mundo", isin: MUNDO, name: "Fondo Mundo" }]);
    const attachment = paper();

    const found = foundByWorthline(
      transferOf(attachment),
      await readTransferBook(store, [attachment]),
    );

    expect(found?.destination).toMatch(/^no está en tu patrimonio/);
    expect(found?.destination).toContain(`ISIN ${EMERGENTES}`);
    expect(found?.destination).toContain("propose_holding sin apertura");
    expect(found?.destination).toContain("después, el traspaso");
  });

  it("several holdings: all of them by name and id, and the app does not pick", async () => {
    const { ids, store } = await book([
      { id: "mundo", isin: MUNDO, name: "Fondo Mundo" },
      { id: "em-a", isin: EMERGENTES, name: "Emergentes en el bróker" },
      { id: "em-b", isin: EMERGENTES, name: "Emergentes en la cartera" },
    ]);
    const attachment = paper();

    const found = foundByWorthline(
      transferOf(attachment),
      await readTransferBook(store, [attachment]),
    );

    expect(found?.destination).toBe(
      `varias posiciones: «Emergentes en el bróker» (${ids["em-a"]}), ` +
        `«Emergentes en la cartera» (${ids["em-b"]}). Pregunta cuál es; no elijas tú.`,
    );
  });

  it("matches a plan de pensiones by its DGS code", async () => {
    const { ids, store } = await book([
      { id: "mundo", isin: MUNDO, name: "Fondo Mundo" },
    ]);
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "plan",
      instrument: "pension_plan",
      name: "Plan Ejemplo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      securityId: { kind: "dgs", value: "N5394" },
    });
    const planId = (await store.agentView.readPublicIds()).find(
      (row) => row.entityId === "plan",
    )?.publicId;
    const attachment = paper({ destination: { dgsCode: "N5394" } });

    const found = foundByWorthline(
      transferOf(attachment),
      await readTransferBook(store, [attachment]),
    );

    expect(found?.destination).toBe(`en tu patrimonio: «Plan Ejemplo» (${planId})`);
    expect(found?.origin).toContain(ids["mundo"]!);
  });

  it("a side whose paper prints no identifier says nothing: worthline searched for nothing", async () => {
    const { store } = await book([{ id: "mundo", isin: MUNDO, name: "Fondo Mundo" }]);
    const attachment = paper({ destination: {} });

    const found = foundByWorthline(
      transferOf(attachment),
      await readTransferBook(store, [attachment]),
    );

    expect(found).not.toHaveProperty("destination");
    expect(found?.origin).toMatch(/^en tu patrimonio/);
  });

  it("with no traspaso paper in the window, the book is not even read", async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the store must not be read without a traspaso paper");
        },
      },
    ) as WorthlineStore;

    expect(await readTransferBook(untouchable, [])).toBe(EMPTY_TRANSFER_BOOK);
  });
});

describe("transferBookHoldings", () => {
  it("lists every holding the lines name, once, for the turn to count as read (#1263)", async () => {
    const { ids, store } = await book([
      { id: "mundo", isin: MUNDO, name: "Fondo Mundo" },
      { id: "em-a", isin: EMERGENTES, name: "Emergentes A" },
      { id: "em-b", isin: EMERGENTES, name: "Emergentes B" },
    ]);
    const attachments = [paper(), paper()];

    const holdings = transferBookHoldings(
      attachments,
      await readTransferBook(store, attachments),
    );

    expect(holdings.map((holding) => holding.id).sort()).toEqual(
      [ids["mundo"], ids["em-a"], ids["em-b"]].sort(),
    );
  });
});
