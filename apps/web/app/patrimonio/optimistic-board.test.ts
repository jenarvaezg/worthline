import type { PortfolioGroup, UnifiedHolding } from "@worthline/domain";
import type { TrashView } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { applyBoardMutations, type BoardModel } from "./optimistic-board";

/**
 * The pure optimistic-merge for the /patrimonio balance board (#521, S5 of
 * #485, interaction-patterns §4/§7). The client island folds the in-flight
 * mutation(s) over the server-rendered model so a delete vanishes the row (and
 * lands it in the trash) BEFORE the Server Action resolves; the redirect that
 * the action ends with re-renders server truth and settles it. Kept pure (no
 * React, no `window`) so the behaviour is unit-tested in the node env while the
 * component stays a thin `useOptimistic` shell — the established
 * `composition-chart-hover` / `view-state` split.
 *
 * Only the PREDICTABLE board mutations live here (§4): `delete` (row → trash),
 * `hardDelete` and `emptyTrash` (trash shrinks). `restore` is deliberately NOT
 * optimistic — the board row it would re-add cannot be reconstructed from the
 * trash's `{id,name}`, so it stays an honest pending instead of a faked value.
 */

/** A minimal asset holding — the merge only reads `id`, `name`, `direction`. */
function asset(id: string, name: string, valueMinor: number): UnifiedHolding {
  return { direction: "asset", id, name, valueMinor } as unknown as UnifiedHolding;
}

/** A minimal liability holding. */
function liability(id: string, name: string, balanceMinor: number): UnifiedHolding {
  return {
    direction: "liability",
    id,
    name,
    balanceMinor,
  } as unknown as UnifiedHolding;
}

function group(key: string, holdings: UnifiedHolding[]): PortfolioGroup {
  return {
    key,
    label: key,
    holdings,
    totalMinor: { amountMinor: 0, currency: "EUR" },
  };
}

const emptyTrash: TrashView = { assets: [], liabilities: [] };

describe("applyBoardMutations · delete", () => {
  test("removes the asset from its group and lands it in the trash", () => {
    const base: BoardModel = {
      groups: [group("cash", [asset("a1", "Cuenta ING", 5000_00)])],
      trash: emptyTrash,
    };

    const next = applyBoardMutations(base, [{ kind: "delete", id: "a1" }]);

    expect(next.groups[0]!.holdings).toEqual([]);
    expect(next.trash.assets).toEqual([{ id: "a1", name: "Cuenta ING" }]);
    expect(next.trash.liabilities).toEqual([]);
  });
});

describe("applyBoardMutations · hardDelete", () => {
  test("removes the entry from the trash (asset side)", () => {
    const base: BoardModel = {
      groups: [],
      trash: { assets: [{ id: "a1", name: "Cuenta vieja" }], liabilities: [] },
    };

    const next = applyBoardMutations(base, [{ kind: "hardDelete", id: "a1" }]);

    expect(next.trash.assets).toEqual([]);
  });
});

describe("applyBoardMutations · emptyTrash", () => {
  test("clears both trash lists", () => {
    const base: BoardModel = {
      groups: [],
      trash: {
        assets: [{ id: "a1", name: "Cuenta vieja" }],
        liabilities: [{ id: "l1", name: "Préstamo saldado" }],
      },
    };

    const next = applyBoardMutations(base, [{ kind: "emptyTrash" }]);

    expect(next.trash).toEqual({ assets: [], liabilities: [] });
  });
});

describe("applyBoardMutations · edges and composition", () => {
  test("a deleted liability lands on the trash's liability side", () => {
    const base: BoardModel = {
      groups: [group("debt", [liability("l1", "Hipoteca", 100_000_00)])],
      trash: emptyTrash,
    };

    const next = applyBoardMutations(base, [{ kind: "delete", id: "l1" }]);

    expect(next.trash.liabilities).toEqual([{ id: "l1", name: "Hipoteca" }]);
    expect(next.trash.assets).toEqual([]);
  });

  test("deleting an unknown id is a no-op (returns the same model)", () => {
    const base: BoardModel = {
      groups: [group("cash", [asset("a1", "Cuenta ING", 5000_00)])],
      trash: emptyTrash,
    };

    expect(applyBoardMutations(base, [{ kind: "delete", id: "ghost" }])).toBe(base);
  });

  test("never mutates the base model (panes and trash are fresh copies)", () => {
    const base: BoardModel = {
      groups: [group("cash", [asset("a1", "Cuenta ING", 5000_00)])],
      trash: emptyTrash,
    };

    applyBoardMutations(base, [{ kind: "delete", id: "a1" }]);

    expect(base.groups[0]!.holdings).toHaveLength(1);
    expect(base.trash.assets).toEqual([]);
  });

  test("folds mutations in order: a delete then emptyTrash vanishes the row and clears", () => {
    const base: BoardModel = {
      groups: [group("cash", [asset("a1", "Cuenta ING", 5000_00)])],
      trash: emptyTrash,
    };

    const next = applyBoardMutations(base, [
      { kind: "delete", id: "a1" },
      { kind: "emptyTrash" },
    ]);

    expect(next.groups[0]!.holdings).toEqual([]);
    expect(next.trash).toEqual({ assets: [], liabilities: [] });
  });
});
