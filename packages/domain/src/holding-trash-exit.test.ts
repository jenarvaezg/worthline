import { describe, expect, test } from "vitest";

import {
  checkHoldingTrashGate,
  parseTrashExit,
  trashExitLabel,
} from "./holding-trash-exit";

/**
 * The generic trash gate (#1549, ADR 0085). Groupama is the case it exists for: a
 * fund with 7.642 € inside went to the Papelera and the money left the patrimonio
 * with nothing recorded. The rule the door enforces is here, pure, so both write
 * paths (the ficha and the assistant's batch) read the same one.
 */
describe("checkHoldingTrashGate — money inside cannot leave in silence", () => {
  test("a holding with no operations ledger passes: nothing to say where it went", () => {
    expect(
      checkHoldingTrashGate({ containerPortfolio: null, exit: null, netUnits: null }),
    ).toBeNull();
  });

  test("a sold-out position passes with no exit — the trash takes nothing", () => {
    expect(
      checkHoldingTrashGate({ containerPortfolio: null, exit: null, netUnits: "0" }),
    ).toBeNull();
  });

  test("sub-unit dust reads as closed, exactly as every other rule reads it", () => {
    expect(
      checkHoldingTrashGate({
        containerPortfolio: null,
        exit: null,
        netUnits: "0.00001",
      }),
    ).toBeNull();
  });

  test("live units with no exit are refused, and the refusal names them", () => {
    expect(
      checkHoldingTrashGate({ containerPortfolio: null, exit: null, netUnits: "120.5" }),
    ).toEqual({ netUnits: "120.5", reason: "needs_exit" });
  });

  test("only «error de registro» archives money that is still inside", () => {
    expect(
      checkHoldingTrashGate({
        containerPortfolio: null,
        exit: "mis_entry",
        netUnits: "120.5",
      }),
    ).toBeNull();
  });

  test("«lo vendí» and «lo traspasé» are NOT keys: they are exits that empty the position first", () => {
    for (const exit of ["sold", "transferred"] as const) {
      expect(
        checkHoldingTrashGate({ containerPortfolio: null, exit, netUnits: "120.5" }),
      ).toEqual({ netUnits: "120.5", reason: "needs_exit" });
    }
  });

  test("recorded on a position that is already empty, those exits pass", () => {
    for (const exit of ["sold", "transferred"] as const) {
      expect(
        checkHoldingTrashGate({ containerPortfolio: null, exit, netUnits: "0" }),
      ).toBeNull();
    }
  });
});

describe("checkHoldingTrashGate — a managed portfolio's cash box is not a position", () => {
  test("the container's cash cannot be trashed while the portfolio lives", () => {
    expect(
      checkHoldingTrashGate({
        containerPortfolio: "Cartera Indexada Metal",
        exit: null,
        netUnits: null,
      }),
    ).toEqual({ portfolioName: "Cartera Indexada Metal", reason: "portfolio_cash" });
  });

  test("no exit unlocks it — not even «error de registro»", () => {
    expect(
      checkHoldingTrashGate({
        containerPortfolio: "Cartera Indexada Metal",
        exit: "mis_entry",
        netUnits: null,
      }),
    ).toEqual({ portfolioName: "Cartera Indexada Metal", reason: "portfolio_cash" });
  });

  test("the container rule wins over the balance rule — one refusal, the actionable one", () => {
    expect(
      checkHoldingTrashGate({
        containerPortfolio: "Cartera Indexada Metal",
        exit: null,
        netUnits: "12",
      }),
    ).toEqual({ portfolioName: "Cartera Indexada Metal", reason: "portfolio_cash" });
  });
});

describe("parseTrashExit — untrusted form input", () => {
  test("accepts the three exits and nothing else", () => {
    expect(parseTrashExit("sold")).toBe("sold");
    expect(parseTrashExit("transferred")).toBe("transferred");
    expect(parseTrashExit("mis_entry")).toBe("mis_entry");
    expect(parseTrashExit("")).toBeNull();
    expect(parseTrashExit("mis-entry")).toBeNull();
    expect(parseTrashExit(undefined)).toBeNull();
    expect(parseTrashExit(7)).toBeNull();
  });
});

describe("trashExitLabel — what the Papelera says about a row", () => {
  test("each exit reads as the sentence the owner would say", () => {
    expect(trashExitLabel("sold")).toBe("vendido");
    expect(trashExitLabel("transferred")).toBe("traspasado");
    expect(trashExitLabel("mis_entry")).toBe("error de registro");
  });
});
