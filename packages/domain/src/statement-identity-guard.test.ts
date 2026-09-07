import { describe, expect, test } from "vitest";

import type { SecurityId } from "./security-id";
import { resolvePerHoldingStatementIdentityGuard } from "./statement-identity-guard";
import type { ParsedStatement } from "./statement-parse";

function statementWithIdentifiers(
  identifiers: Array<string | null>,
  typed?: SecurityId,
): ParsedStatement {
  return {
    directionResolved: true,
    isin: identifiers.length === 1 ? (identifiers[0] ?? null) : null,
    isins: identifiers.filter((identifier): identifier is string => Boolean(identifier)),
    rows: identifiers.map((identifier, index) => ({
      currency: "EUR",
      dateKey: `2026-01-${String(index + 1).padStart(2, "0")}`,
      feesMinor: 0,
      isin: identifier,
      kind: "buy",
      pricePerUnit: "10",
      units: "1",
      ...(typed ? { securityId: typed } : {}),
    })),
    skipped: [],
  };
}

/**
 * The per-holding identity guard (ADR 0018 S4, generalized by #1748): a statement
 * must not be grafted onto the wrong holding. The file's identifier is compared to
 * the holding's TYPED pair — same lane, same value — so a plan's DGS code and an
 * ISIN never pass for each other; an empty hole is filled with what validates.
 */
describe("resolvePerHoldingStatementIdentityGuard (ADR 0055 one-fund case)", () => {
  test("every file row on the holding's own ISIN proceeds", () => {
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["ie00byx5nx33", " IE00BYX5NX33 "]),
        { instrument: "fund", securityId: { kind: "isin", value: "IE00BYX5NX33" } },
      ),
    ).toEqual({ status: "match" });
  });

  test("any row on another identifier rejects the per-holding upload", () => {
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["IE00BYX5NX33", "LU0000000009"]),
        { instrument: "fund", securityId: { kind: "isin", value: "IE00BYX5NX33" } },
      ),
    ).toEqual({
      fileIdentifiers: ["IE00BYX5NX33", "LU0000000009"],
      status: "mismatch",
    });
  });

  test("a file with no identifier at all is absent — nothing to guard", () => {
    expect(
      resolvePerHoldingStatementIdentityGuard(statementWithIdentifiers([null]), {
        instrument: "fund",
        securityId: { kind: "isin", value: "IE00BYX5NX33" },
      }),
    ).toEqual({ status: "absent" });
  });

  test("a plan's DGS code is guarded in its OWN lane, never against an ISIN", () => {
    // The plan's own paper: the code matches what the holding declares.
    expect(
      resolvePerHoldingStatementIdentityGuard(statementWithIdentifiers(["N-5394"]), {
        instrument: "pension_plan",
        securityId: { kind: "dgs", value: "N5394" },
      }),
    ).toEqual({ status: "match" });

    // A fund's statement on the plan's holding is the slip this guard exists for.
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["IE00BYX5NX33"]),
        { instrument: "pension_plan", securityId: { kind: "dgs", value: "N5394" } },
      ),
    ).toEqual({ fileIdentifiers: ["IE00BYX5NX33"], status: "mismatch" });

    // Another plan's code is a mismatch too — same lane, different plan.
    expect(
      resolvePerHoldingStatementIdentityGuard(statementWithIdentifiers(["N5396"]), {
        instrument: "pension_plan",
        securityId: { kind: "dgs", value: "N5394" },
      }),
    ).toEqual({ fileIdentifiers: ["N5396"], status: "mismatch" });
  });

  test("an empty hole is filled from a single file identifier, typed", () => {
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["ie00byx5nx33", " IE00BYX5NX33 "]),
        { instrument: "fund" },
      ),
    ).toEqual({
      securityId: { kind: "isin", value: "IE00BYX5NX33" },
      status: "backfill",
    });

    // The new half of #1748: a plan learns its DGS code from its own paper.
    expect(
      resolvePerHoldingStatementIdentityGuard(statementWithIdentifiers(["N-5394"]), {
        instrument: "pension_plan",
      }),
    ).toEqual({
      securityId: { kind: "dgs", value: "N5394" },
      status: "backfill",
    });
  });

  test("nothing is written that the holding could not carry (#1453)", () => {
    // A plan does not take an ISIN, and a fund does not take a plan code: the load
    // proceeds (an empty hole guards nothing) but the column stays empty.
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["IE00BYX5NX33"]),
        { instrument: "pension_plan" },
      ),
    ).toEqual({ status: "absent" });
    expect(
      resolvePerHoldingStatementIdentityGuard(statementWithIdentifiers(["N5394"]), {
        instrument: "fund",
      }),
    ).toEqual({ status: "absent" });
    // Neither is a plantilla key that identifies nothing (a finect slug).
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["N5394-Myinvestor_pp"]),
        { instrument: "pension_plan" },
      ),
    ).toEqual({ status: "absent" });
  });

  test("an empty hole with two file identifiers is a mismatch, not a coin toss", () => {
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["IE00BYX5NX33", "LU0000000009"]),
        { instrument: "fund" },
      ),
    ).toEqual({
      fileIdentifiers: ["IE00BYX5NX33", "LU0000000009"],
      status: "mismatch",
    });
  });

  test("a preserved import (kind null) occupies the hole and is never overwritten", () => {
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["IE00BYX5NX33"]),
        {
          instrument: "fund",
          securityId: { kind: null, value: "algo-que-nadie-supo-leer" },
        },
      ),
    ).toEqual({ fileIdentifiers: ["IE00BYX5NX33"], status: "mismatch" });
  });

  test("the row's TYPED pair wins over its raw column, and a mistyped pair matches nothing", () => {
    // A document read by the assistant states the pair; the raw column is a copy.
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["N5394"], { kind: "dgs", value: "N5394" }),
        { instrument: "pension_plan", securityId: { kind: "dgs", value: "N5394" } },
      ),
    ).toEqual({ status: "match" });

    // A pair whose value does not validate as its kind claims no identifier: the
    // guard sees a file with nothing to compare, not a match.
    expect(
      resolvePerHoldingStatementIdentityGuard(
        statementWithIdentifiers(["N5394"], { kind: "isin", value: "N5394" }),
        { instrument: "pension_plan", securityId: { kind: "dgs", value: "N5394" } },
      ),
    ).toEqual({ status: "absent" });
  });
});
