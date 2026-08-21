/**
 * The traspaso form's pure seam (#1480, S3 of PRD #1393): what the screen reads
 * off the fields, and the pair it previews before submitting them.
 *
 * The preview is asserted against `planTransfer` itself, never against a second
 * arithmetic: #1438 measured what two engines cost — 266 wrong snapshots from a
 * preview that disagreed with the writer. So these tests pin the ADAPTER (fields →
 * intent → the figures a form prints) and let the plan own the numbers.
 */

import type { InvestmentOperation, ManualAsset } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  NEW_DESTINATION,
  parseTransferForm,
  previewTransfer,
  readTransferFormValues,
  type SubmissionKeyRef,
  stampTransferSubmission,
  type TransferFormValues,
  transferDestinationOptions,
} from "./transfer-form";

const TODAY = "2026-08-21";
/** 100 participaciones bought at 10 € — 1.000 € of cost basis. */
const BUY: InvestmentOperation = {
  assetId: "h-origin",
  currency: "EUR",
  executedAt: "2025-01-15",
  feesMinor: 0,
  id: "op_compra",
  kind: "buy",
  pricePerUnit: "10",
  units: "100",
};
const ORIGIN = {
  assetId: "h-origin",
  currency: "EUR" as const,
  operations: [BUY],
};

function values(over: Partial<TransferFormValues> = {}): TransferFormValues {
  return {
    amount: "739,22",
    destinationAmount: "",
    destinationAssetId: "h-destination",
    destinationPricePerUnit: "14,50",
    executedAt: "2026-08-14",
    newDestinationIsin: "",
    newDestinationName: "",
    originPricePerUnit: "12,00",
    portion: "amount",
    ...over,
  };
}

describe("readTransferFormValues", () => {
  test("reads every field a submitted traspaso form carries", () => {
    const formData = new FormData();
    formData.set("destinationAssetId", NEW_DESTINATION);
    formData.set("newDestinationName", "  Value PP  ");
    formData.set("newDestinationIsin", " es0173894017 ");
    formData.set("executedAt", "2026-08-14");
    formData.set("portion", "all");
    formData.set("amount", "739,22");
    formData.set("originPricePerUnit", "12,00");
    formData.set("destinationPricePerUnit", "14,50");
    formData.set("destinationAmount", "740,72");

    expect(readTransferFormValues(formData)).toEqual({
      amount: "739,22",
      destinationAmount: "740,72",
      destinationAssetId: NEW_DESTINATION,
      destinationPricePerUnit: "14,50",
      executedAt: "2026-08-14",
      newDestinationIsin: "es0173894017",
      newDestinationName: "Value PP",
      originPricePerUnit: "12,00",
      portion: "all",
    });
  });

  test("a form that omits a field reads as blank, never as undefined", () => {
    expect(readTransferFormValues(new FormData())).toEqual({
      amount: "",
      destinationAmount: "",
      destinationAssetId: "",
      destinationPricePerUnit: "",
      executedAt: "",
      newDestinationIsin: "",
      newDestinationName: "",
      originPricePerUnit: "",
      portion: "",
    });
  });
});

describe("parseTransferForm", () => {
  test("an existing destination, an importe and the two VLs make a draft", () => {
    const parsed = parseTransferForm(values(), TODAY);

    expect(parsed).toEqual({
      ok: true,
      command: {
        destination: { kind: "existing", assetId: "h-destination" },
        destinationPricePerUnit: "14.50",
        executedAt: "2026-08-14",
        originPricePerUnit: "12.00",
        portion: { kind: "amount", amountMinor: 73_922 },
      },
    });
  });

  test("«todo» is its own intent — the importe field is not even read", () => {
    const parsed = parseTransferForm(values({ amount: "", portion: "all" }), TODAY);

    expect(parsed.ok && parsed.command.portion).toEqual({ kind: "all" });
  });

  test("an empty date is today, so a form submitted untouched is dated honestly", () => {
    const parsed = parseTransferForm(values({ executedAt: "" }), TODAY);

    expect(parsed.ok && parsed.command.executedAt).toBe(TODAY);
  });

  test("the amount that ARRIVED rides the draft when the bank states a different one", () => {
    const parsed = parseTransferForm(values({ destinationAmount: "740,72" }), TODAY);

    expect(parsed.ok && parsed.command.destinationAmountMinor).toBe(74_072);
  });

  test("a blank arrival amount means «the same», not zero", () => {
    const parsed = parseTransferForm(values({ destinationAmount: "" }), TODAY);

    expect(parsed.ok && "destinationAmountMinor" in parsed.command).toBe(false);
  });

  test("a new destination carries its name, trimmed, and its normalized ISIN", () => {
    const parsed = parseTransferForm(
      values({
        destinationAssetId: NEW_DESTINATION,
        newDestinationIsin: "es0173894017",
        newDestinationName: "Cartera Permanente PP",
      }),
      TODAY,
    );

    expect(parsed.ok && parsed.command.destination).toEqual({
      isin: "ES0173894017",
      kind: "new",
      name: "Cartera Permanente PP",
    });
  });

  test("a new destination with no ISIN is allowed — a pension plan often has none", () => {
    const parsed = parseTransferForm(
      values({ destinationAssetId: NEW_DESTINATION, newDestinationName: "Value PP" }),
      TODAY,
    );

    expect(parsed.ok && parsed.command.destination).toEqual({
      kind: "new",
      name: "Value PP",
    });
  });

  test.each([
    ["no destination chosen", { destinationAssetId: "" }, "destino"],
    [
      "a new destination with no name",
      { destinationAssetId: NEW_DESTINATION, newDestinationName: "  " },
      "nombre",
    ],
    [
      "an ISIN that fails its check digit",
      {
        destinationAssetId: NEW_DESTINATION,
        newDestinationIsin: "ES0173894013",
        newDestinationName: "Value PP",
      },
      "ISIN",
    ],
    ["a blank importe", { amount: "" }, "importe"],
    ["a zero importe", { amount: "0" }, "importe"],
    ["a blank VL de origen", { originPricePerUnit: "" }, "origen"],
    ["a blank VL de destino", { destinationPricePerUnit: "" }, "destino"],
    ["an unreadable arrival amount", { destinationAmount: "mil" }, "llegó"],
  ])("refuses %s", (_case, over, expected) => {
    const parsed = parseTransferForm(values(over), TODAY);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(expected);
  });
});

describe("previewTransfer", () => {
  test("prints the pair the gate would write — units cut where the app reads them", () => {
    const preview = previewTransfer(
      values({ amount: "739,22", destinationPricePerUnit: "14,50" }),
      ORIGIN,
      TODAY,
    );

    // 739,22 ÷ 12 = 61,60166666…  →  six decimals (#1395), never twenty.
    expect(preview).toEqual({
      inUnits: "50.98069",
      incomingAmountMinor: 73_922,
      inheritedCostMinor: 61_602,
      outUnits: "61.601667",
      outgoingAmountMinor: 73_922,
      status: "ready",
    });
  });

  test("«todo» takes the position itself, so the origin reads empty afterwards", () => {
    const preview = previewTransfer(values({ portion: "all" }), ORIGIN, TODAY);

    expect(preview).toMatchObject({
      // The whole position, not `importe ÷ VL` — a leftover millionth of a unit is a
      // phantom holding in every list and donut.
      outUnits: "100",
      outgoingAmountMinor: 120_000,
      status: "ready",
    });
  });

  test("an importe above the position is REFUSED in the form, offering «todo»", () => {
    const preview = previewTransfer(values({ amount: "5.000,00" }), ORIGIN, TODAY);

    expect(preview.status).toBe("refused");
    expect(preview.status === "refused" && preview.message).toContain("todo");
  });

  test("a half-typed form says nothing rather than shouting a refusal", () => {
    expect(previewTransfer(values({ amount: "" }), ORIGIN, TODAY).status).toBe(
      "incomplete",
    );
    expect(
      previewTransfer(values({ destinationAssetId: "" }), ORIGIN, TODAY).status,
    ).toBe("incomplete");
  });

  test("a destination still being created previews too — its id is not the point", () => {
    const preview = previewTransfer(
      values({ destinationAssetId: NEW_DESTINATION, newDestinationName: "Value PP" }),
      ORIGIN,
      TODAY,
    );

    expect(preview.status).toBe("ready");
  });

  test("the two halves do NOT have to match in importe (739,22 out, 740,72 in)", () => {
    const preview = previewTransfer(
      values({ destinationAmount: "740,72" }),
      ORIGIN,
      TODAY,
    );

    expect(preview).toMatchObject({
      incomingAmountMinor: 74_072,
      outgoingAmountMinor: 73_922,
      status: "ready",
    });
  });

  test("folds the origin AT THE TRANSFER DATE, not today (#1438)", () => {
    // A purchase made AFTER the traspaso neither backs the amount that left nor lends
    // its cost to the destination. Folding today's position instead would preview a
    // traspaso the gate then refuses — or, worse, accept one the position never
    // covered on the day it happened.
    const laterBuy: InvestmentOperation = {
      ...BUY,
      executedAt: "2026-08-20",
      id: "op_posterior",
      pricePerUnit: "12",
      units: "500",
    };

    const preview = previewTransfer(
      values({ amount: "5.000,00" }),
      { ...ORIGIN, operations: [BUY, laterBuy] },
      TODAY,
    );

    // 5.000 € ÷ 12 = 416 participaciones: covered by today's 600, not by the 100 the
    // holding had on 14-ago.
    expect(preview.status).toBe("refused");
  });

  test("«todo» on a past date empties the position of THAT date", () => {
    const laterBuy: InvestmentOperation = {
      ...BUY,
      executedAt: "2026-08-20",
      id: "op_posterior",
      units: "50",
    };

    const preview = previewTransfer(
      values({ portion: "all" }),
      { ...ORIGIN, operations: [BUY, laterBuy] },
      TODAY,
    );

    expect(preview).toMatchObject({ outUnits: "100", status: "ready" });
  });

  test("a traspaso onto the holding itself is refused, not previewed", () => {
    const preview = previewTransfer(
      values({ destinationAssetId: ORIGIN.assetId }),
      ORIGIN,
      TODAY,
    );

    expect(preview.status).toBe("refused");
  });
});

describe("transferDestinationOptions", () => {
  function asset(over: Partial<ManualAsset> & { id: string; name: string }): ManualAsset {
    return {
      currency: "EUR",
      currentValue: { amountMinor: 0, currency: "EUR" },
      instrument: "fund",
      isPrimaryResidence: false,
      liquidityTier: "market",
      ownership: [],
      type: "investment",
      ...over,
    } as ManualAsset;
  }

  const ORIGIN_ASSET = { assetId: "h-origen", currency: "EUR" };

  test("lists the workspace's other funds, alphabetically, with their cached VL", () => {
    const options = transferDestinationOptions(
      [
        asset({ id: "h-value", name: "Value PP" }),
        asset({ id: "h-origen", name: "Indexado PP" }),
        asset({ id: "h-cartera", name: "Cartera Permanente PP" }),
      ],
      [{ assetId: "h-cartera", currentPricePerUnit: "14.50" }],
      ORIGIN_ASSET,
    );

    expect(options).toEqual([
      { assetId: "h-cartera", name: "Cartera Permanente PP", pricePerUnit: "14.50" },
      { assetId: "h-value", name: "Value PP" },
    ]);
  });

  test("leaves out what the gate would refuse or break on", () => {
    const options = transferDestinationOptions(
      [
        // Stored value: no participaciones to receive.
        asset({ id: "h-cash", instrument: "current_account", name: "Cuenta" }),
        // Connected: its next sync would overwrite the half written by hand.
        asset({ connectedSourceId: "src_1", id: "h-binance", name: "Binance" }),
        // Another currency: the inherited cost would need a rate nobody stated.
        asset({ currency: "USD", id: "h-usd", name: "Fondo en dólares" }),
        asset({ id: "h-ok", name: "Fondo elegible" }),
      ],
      [],
      ORIGIN_ASSET,
    );

    expect(options.map((option) => option.assetId)).toEqual(["h-ok"]);
  });
});

describe("stampTransferSubmission", () => {
  test("writes the key onto the body AND publishes it as in-flight (#1394)", () => {
    const formData = new FormData();
    const keyRef: SubmissionKeyRef = { current: null };

    const key = stampTransferSubmission(formData, keyRef, () => "k1");

    expect(key).toBe("k1");
    expect(formData.get("submissionId")).toBe("k1");
    // Published synchronously: the second click of a double click happens before any
    // pending flag has flipped, so the ref is the only thing that can catch it.
    expect(keyRef.current).toBe("k1");
  });

  test("a submit while one is in flight reuses its key, so the server sees a replay", () => {
    const keyRef: SubmissionKeyRef = { current: "k1" };
    const formData = new FormData();

    expect(stampTransferSubmission(formData, keyRef, () => "k2")).toBe("k1");
    expect(formData.get("submissionId")).toBe("k1");
  });

  test("once it settles, the next submit is a NEW traspaso and not a replay", () => {
    const keyRef: SubmissionKeyRef = { current: null };

    stampTransferSubmission(new FormData(), keyRef, () => "k1");
    keyRef.current = null; // what the island's `finally` does

    expect(stampTransferSubmission(new FormData(), keyRef, () => "k2")).toBe("k2");
  });
});
