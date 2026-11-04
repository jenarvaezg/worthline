import { describe, expect, it } from "vitest";

import { anonymizeCapture } from "./anonymize";
import { createFigureMap } from "./figure-map";
import { createPseudonymizer } from "./pseudonymizer";
import { TEXTBOOK_DNI, TEXTBOOK_IBAN } from "./textbook-identities";

const SECRET = "test-secret-not-the-real-one";
const options = () => ({
  pseudonyms: createPseudonymizer(SECRET),
  figures: createFigureMap(SECRET),
});

// An invented capture with the shape of the real ones: no value here is real.
const CASH_ACCOUNTS = `{
  "status": { "timestamp": "2026-01-01T00:00:00.000Z", "code": "OK" },
  "payload": {
    "data": [
      {
        "accountId": "100001",
        "accountUuid": "00000000-0000-4000-8000-000000000001",
        "accountCode": "1000000001",
        "accountType": "CASH_ACCOUNT",
        "alias": "Cuenta de prueba",
        "enabledBalance": 10.50,
        "withheldBalance": 43.70,
        "iban": "${TEXTBOOK_IBAN}",
        "holders": [
          {
            "id": "00000000-0000-4000-8000-000000000002",
            "name": "LUCIA",
            "documentNumber": "${TEXTBOOK_DNI}",
            "surname1": "PRUEBA",
            "surname2": "EJEMPLO",
            "me": true,
            "participantType": "OWNER"
          }
        ],
        "currency": "EUR",
        "creationDate": "2024-01-01T10:00:00"
      }
    ]
  }
}`;

const PENSION_ACCOUNT = `{
  "status": { "timestamp": "2026-01-01T00:00:00.000Z", "code": "OK" },
  "payload": {
    "data": [
      {
        "accountPensionId": 100002,
        "dgsCode": "N5394",
        "name": "UN PLAN DE PENSIONES PP",
        "shares": 318.4270,
        "averageCost": 13.9072215060000,
        "liquidationValue": 23.4417,
        "totalReturn": 18.315,
        "minFirstSubscription": { "amount": 12.50, "firstSubscriptionType": "AMOUNT" }
      }
    ]
  }
}`;

const POSITIONS = `{
  "status": { "timestamp": "2026-01-01T00:00:00.000Z", "code": "OK" },
  "payload": {
    "data": {
      "positions": {
        "IE00BYX5NX33": [
          { "date": "2025-01-01", "marketValue": 100.10, "investmentAddedValue": 87,
            "returnValue": 1.5, "currencyMarketValue": 100.10, "totalShares": 7.5,
            "avgPositionCost": 12 }
        ]
      },
      "labelGraph": "Rentabilidad",
      "symbolGraph": "€",
      "currency": "EUR"
    }
  }
}`;

function run(text: string) {
  const opts = options();
  return { ...opts, out: JSON.parse(anonymizeCapture(text, opts)) };
}

describe("anonymizeCapture", () => {
  it("replaces every identifier by its stable fake", () => {
    const { pseudonyms, out } = run(CASH_ACCOUNTS);
    const account = out.payload.data[0];
    expect(account.accountId).toBe(pseudonyms.digits("100001"));
    expect(account.accountCode).toBe(pseudonyms.digits("1000000001"));
    expect(account.accountUuid).toBe(
      pseudonyms.uuid("00000000-0000-4000-8000-000000000001"),
    );
    expect(account.iban).toBe(pseudonyms.iban(TEXTBOOK_IBAN));
    expect(account.alias).toBe(pseudonyms.alias("Cuenta de prueba"));
    const holder = account.holders[0];
    expect(holder.id).toBe(pseudonyms.uuid("00000000-0000-4000-8000-000000000002"));
    expect(holder.documentNumber).toBe(pseudonyms.document(TEXTBOOK_DNI));
    expect(holder.name).toBe(pseudonyms.personName("LUCIA"));
    expect(holder.surname1).toBe(pseudonyms.personName("PRUEBA"));
  });

  it("replaces every amount and share count by its invented fake", () => {
    const { figures, out } = run(CASH_ACCOUNTS);
    expect(String(out.payload.data[0].enabledBalance)).toBe(figures.amount("10.50"));
    expect(String(out.payload.data[0].withheldBalance)).toBe(figures.amount("43.7"));
    const run2 = run(POSITIONS);
    const series = run2.out.payload.data.positions.IE00BYX5NX33[0];
    expect(String(series.marketValue)).toBe(run2.figures.amount("100.10"));
    expect(series.currencyMarketValue).toBe(series.marketValue);
    expect(String(series.totalShares)).toBe(run2.figures.quantity("7.5", 1));
    expect(series.totalShares).not.toBe(7.5);
  });

  it("leaves prices, codes, enums, operation dates and catalog minimums as they were", () => {
    const { out } = run(PENSION_ACCOUNT);
    const plan = out.payload.data[0];
    expect(plan.dgsCode).toBe("N5394");
    expect(plan.name).toBe("UN PLAN DE PENSIONES PP");
    expect(plan.liquidationValue).toBe(23.4417);
    expect(plan.totalReturn).toBe(18.315);
    expect(plan.minFirstSubscription.amount).toBe(12.5);
    expect(plan.averageCost).not.toBe(13.907221506);
    const cash = run(CASH_ACCOUNTS).out.payload.data[0];
    expect(cash.creationDate).toBe("2024-01-01T10:00:00");
    expect(cash.holders[0].participantType).toBe("OWNER");
    const positions = run(POSITIONS).out.payload.data;
    expect(Object.keys(positions.positions)).toEqual(["IE00BYX5NX33"]);
    expect(positions.positions.IE00BYX5NX33[0].date).toBe("2025-01-01");
  });

  it("gives a broker order id the same fake as its reference", () => {
    const text = '{ "payload": { "data": [{ "id": "202501150000123" }] } }';
    const { pseudonyms, out } = run(text);
    expect(out.payload.data[0].id).toBe(pseudonyms.reference("202501150000123"));
  });

  it("turns a numeric account id into a numeric fake", () => {
    const { pseudonyms, out } = run(PENSION_ACCOUNT);
    expect(out.payload.data[0].accountPensionId).toBe(
      Number(pseudonyms.digits("100002")),
    );
  });

  it("refuses a key nobody classified, so a new API field cannot slip through", () => {
    const text = `{ "payload": { "data": { "accountId": "100001", "newField": "x" } } }`;
    expect(() => anonymizeCapture(text, options())).toThrow(/newField/);
  });

  it("refuses a map key that is not an ISIN or a DGS code under positions", () => {
    const text = `{ "payload": { "data": { "positions": { "100001": [] } } } }`;
    expect(() => anonymizeCapture(text, options())).toThrow(/positions/);
  });

  it("refuses a value of the wrong type for its rule", () => {
    const text = `{ "payload": { "data": { "iban": 12 } } }`;
    expect(() => anonymizeCapture(text, options())).toThrow(/iban/);
  });

  it("keeps nulls as nulls, also the text 'null' the API sends as an account id", () => {
    const text = `{ "payload": { "data": { "iban": null, "profit": null, "accountId": "null" } } }`;
    const out = JSON.parse(anonymizeCapture(text, options()));
    expect(out.payload.data).toEqual({ iban: null, profit: null, accountId: "null" });
  });
});
