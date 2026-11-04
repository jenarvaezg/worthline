import { describe, expect, it } from "vitest";

import { anonymizeCapture } from "./anonymize";
import { createFigureMap } from "./figure-map";
import { collectSecrets, findLeaks, findTextLeaks, pairedAmounts } from "./leak-check";
import { createPseudonymizer } from "./pseudonymizer";
import { TEXTBOOK_DNI, TEXTBOOK_IBAN } from "./textbook-identities";

const SECRET = "test-secret-not-the-real-one";

// Invented raw captures: no value here is real.
const CASH = JSON.stringify({
  status: { timestamp: "2026-01-02T08:00:00.000Z", code: "OK" },
  payload: {
    data: [
      {
        accountId: "100001",
        alias: "Cartera Prueba",
        enabledBalance: 37.21,
        iban: TEXTBOOK_IBAN,
        holders: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            name: "LUCIA",
            surname1: "PRUEBAZ",
            documentNumber: TEXTBOOK_DNI,
            participantType: "OWNER",
          },
        ],
      },
    ],
  },
});
const CATALOG = JSON.stringify({
  payload: {
    data: [{ id: 7, name: "Cartera Prueba", description: "La Cartera Prueba" }],
  },
});
const RAW = [
  { name: "cash-accounts", text: CASH },
  { name: "portfolios", text: CATALOG },
  { name: "securities-orders-100009", text: JSON.stringify({ payload: { data: [] } }) },
];

const secrets = () => collectSecrets(RAW);
const anonymized = (text: string) =>
  anonymizeCapture(text, {
    pseudonyms: createPseudonymizer(SECRET),
    figures: createFigureMap(SECRET),
  });

describe("findLeaks", () => {
  it("is clean on the anonymized captures", () => {
    expect(
      findLeaks(secrets(), [
        { file: "capture/cash-accounts.json", text: anonymized(CASH) },
        { file: "capture/portfolios.json", text: anonymized(CATALOG) },
      ]),
    ).toEqual([]);
  });

  it("catches every identifier of the raw capture copied as is", () => {
    const kinds = findLeaks(secrets(), [{ file: "capture/x.json", text: CASH }]).map(
      (leak) => `${leak.kind}:${leak.value}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        "identifier:100001",
        `identifier:${TEXTBOOK_IBAN}`,
        "identifier:00000000-0000-4000-8000-000000000002",
        `identifier:${TEXTBOOK_DNI}`,
        "name:lucia",
        "name:pruebaz",
        "amount:37.21",
      ]),
    );
  });

  it("catches an exact amount even when written with other trailing zeros", () => {
    const leaks = findLeaks(secrets(), [
      { file: "capture/x.json", text: '{ "payload": { "data": { "cash": 37.2100 } } }' },
    ]);
    expect(leaks).toEqual([{ file: "capture/x.json", kind: "amount", value: "37.21" }]);
  });

  it("catches a real amount hidden under a key the table does not know", () => {
    const leaks = findLeaks(secrets(), [
      {
        file: "capture/x.json",
        text: '{ "payload": { "data": { "brandNew": 37.21 } } }',
      },
    ]);
    expect(leaks.map((leak) => leak.kind)).toEqual(["amount"]);
  });

  it("catches a real id in a fixture's file name", () => {
    const leaks = findLeaks(secrets(), [
      { file: "capture/securities-orders-100009.json", text: "{}" },
    ]);
    expect(leaks).toEqual([
      {
        file: "capture/securities-orders-100009.json",
        kind: "identifier",
        value: "100009",
      },
    ]);
  });

  it("catches a name inside any text, regardless of case and accents", () => {
    const leaks = findLeaks(secrets(), [
      { file: "capture/x.json", text: '{ "note": "Firmado por Lucía" }' },
    ]);
    expect(leaks).toEqual([{ file: "capture/x.json", kind: "name", value: "lucia" }]);
  });

  it("does not flag a personal text that the API also publishes as catalog data", () => {
    const leaks = findLeaks(secrets(), [
      { file: "capture/x.json", text: '{ "description": "La Cartera Prueba" }' },
    ]);
    expect(leaks).toEqual([]);
  });

  it("does not take the text 'null' the API sends as an id for a secret", () => {
    const quirk = [
      { name: "x", text: '{ "payload": { "data": { "accountId": "null" } } }' },
    ];
    expect(
      findLeaks(collectSecrets(quirk), [
        { file: "capture/x.json", text: '{ "note": null }' },
      ]),
    ).toEqual([]);
  });

  it("catches a real fractional share count, but not a small whole one", () => {
    const raw = [
      {
        name: "x",
        text: '{ "payload": { "data": [{ "shares": 12.345 }, { "shares": 3 }] } }',
      },
    ];
    const leaks = findLeaks(collectSecrets(raw), [
      {
        file: "capture/x.json",
        text: '{ "payload": { "data": [{ "shares": 12.345 }, { "shares": 3 }] } }',
      },
    ]);
    expect(leaks).toEqual([
      { file: "capture/x.json", kind: "quantity", value: "12.345" },
    ]);
  });

  it("does not take a real id hidden among an invented figure's decimals for a leak", () => {
    const leaks = findLeaks(secrets(), [
      {
        file: "capture/x.json",
        text: '{ "payload": { "data": { "cash": 0.1000017 } } }',
      },
    ]);
    expect(leaks).toEqual([]);
  });

  it("pairs each real amount with the fixture's figure at the same place", () => {
    const raw =
      '{ "payload": { "data": [{ "cash": 10, "shares": 2, "amountBuyVL": 5 }, { "cash": 0 }] } }';
    const fake =
      '{ "payload": { "data": [{ "cash": 13.17, "shares": 2.634, "amountBuyVL": 5 }, { "cash": 0 }] } }';
    expect(pairedAmounts(raw, fake)).toEqual([{ real: "10", fake: "13.17" }]);
  });

  it("ignores public figures that happen to equal nothing personal", () => {
    const leaks = findLeaks(secrets(), [
      {
        file: "capture/x.json",
        text: '{ "payload": { "data": [{ "id": 7, "liquidationValue": 37.21 }] } }',
      },
    ]);
    expect(leaks).toEqual([]);
  });
});

describe("findTextLeaks", () => {
  const withOrders = () =>
    collectSecrets([
      ...RAW,
      {
        name: "pension-orders-100010",
        text: '{ "payload": { "data": [{ "cash": 8317, "shares": 12.345 }, { "cash": 100 }] } }',
      },
    ]);
  const scan = (text: string) =>
    findTextLeaks(withOrders(), [{ file: "x.test.ts", text }]);

  it("catches a real figure written in a test, in any notation", () => {
    expect(scan('expect(canonicalDecimal("37.2100")).toBe("37.21");')).toEqual([
      { file: "x.test.ts", kind: "amount", value: "37.21" },
    ]);
    expect(scan("const shares = 12.345;").map((leak) => leak.kind)).toEqual(["amount"]);
    expect(scan("const cash = 8317;").map((leak) => leak.value)).toEqual(["8317"]);
  });

  it("catches identifiers and names anywhere in a text, also in a commit message", () => {
    const leaks = findTextLeaks(withOrders(), [
      { file: "commit", text: "fix: cuenta 100001 de Lucía" },
    ]);
    expect(leaks.map((leak) => `${leak.kind}:${leak.value}`)).toEqual([
      "identifier:100001",
      "name:lucia",
    ]);
  });

  it("leaves small whole numbers, the percent base and versions alone", () => {
    expect(
      scan('multiplyDecimal(profit, "100"); padStart(2, "0"); "1.2.3"; 37.215'),
    ).toEqual([]);
  });

  it("reads a number after a slash as a product version, not a figure", () => {
    expect(scan('"user-agent": "Mozilla/37.21 Chrome/8317"')).toEqual([]);
    expect(scan("price 37.21")).toHaveLength(1);
  });
});
