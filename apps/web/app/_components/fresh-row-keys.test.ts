import { describe, expect, test } from "vitest";

import { freshRowKeys } from "./fresh-row-keys";

/**
 * After a terminal lands, the row it added is pointed at (#1829): «la fila nueva
 * sale destacada». What is new is whatever the server's list holds now that it did
 * not hold on the previous render — the ledger's operation ids, the Cobros grid's
 * row keys — so the highlight follows the data, never a guess about which form
 * wrote what.
 */

describe("freshRowKeys", () => {
  test("a row the server did not list before is fresh", () => {
    const fresh = freshRowKeys(
      { operaciones: ["op_1", "op_2"] },
      { operaciones: ["op_1", "op_2", "op_3"] },
    );

    expect([...(fresh["operaciones"] ?? [])]).toEqual(["op_3"]);
  });

  test("a render that adds nothing points at nothing — a delete included", () => {
    expect(
      freshRowKeys({ operaciones: ["op_1", "op_2"] }, { operaciones: ["op_1"] })[
        "operaciones"
      ]?.size,
    ).toBe(0);
    expect(
      freshRowKeys({ operaciones: ["op_1"] }, { operaciones: ["op_1"] })["operaciones"]
        ?.size,
    ).toBe(0);
  });

  test("each list is compared with itself", () => {
    const fresh = freshRowKeys(
      { cobros: ["oneoff:p1"], operaciones: ["op_1"] },
      { cobros: ["oneoff:p1", "oneoff:p2"], operaciones: ["op_1"] },
    );

    expect([...(fresh["cobros"] ?? [])]).toEqual(["oneoff:p2"]);
    expect(fresh["operaciones"]?.size).toBe(0);
  });

  test("a render that adds several rows is a load, not a registration, and singles none out", () => {
    // Eleven movements from a statement: marking all of them would unfold the
    // compact ledger past its ten latest, and «la fila nueva» is one row.
    const fresh = freshRowKeys(
      { operaciones: ["op_1"] },
      { operaciones: ["op_1", "op_2", "op_3"] },
    );

    expect(fresh["operaciones"]?.size).toBe(0);
  });

  test("a list with no previous render has nothing to compare against, so nothing is fresh", () => {
    // Otherwise the first render of a list would mark every row in it.
    expect(freshRowKeys({}, { cobros: ["oneoff:p1"] })["cobros"]?.size).toBe(0);
  });
});
