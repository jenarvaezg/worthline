import type { TrashView } from "@worthline/db";
import type { PortfolioGroup } from "@worthline/domain";

/**
 * Pure optimistic-merge for the /patrimonio balance board (#521, S5 of #485,
 * interaction-patterns §4/§7). The client island folds the in-flight
 * mutation(s) over the server-rendered model so the change shows BEFORE the
 * Server Action resolves; the redirect that every action ends with re-renders
 * server truth and settles (or, on the error redirect, reverts) it. Pure (no
 * React, no `window`) so it unit-tests in the node env while the component
 * stays a thin `useOptimistic` shell — the `composition-chart-hover` /
 * `view-state` split.
 *
 * Only PREDICTABLE board mutations live here (§4): `delete` (row → trash),
 * `hardDelete` and `emptyTrash` (trash shrinks). `restore` is intentionally
 * absent — the board row it re-adds cannot be reconstructed from the trash's
 * `{id,name}`, so the island shows an honest pending for it instead of faking a
 * value.
 */

/** The board's optimistic-eligible mutations, each tagged by its action. */
export type BoardMutation =
  | { kind: "delete"; id: string }
  | { kind: "hardDelete"; id: string }
  | { kind: "emptyTrash" };

/** The slice of board state an optimistic merge rewrites: the panes + the trash. */
export interface BoardModel {
  groups: PortfolioGroup[];
  trash: TrashView;
}

function applyOne(model: BoardModel, mutation: BoardMutation): BoardModel {
  switch (mutation.kind) {
    case "delete": {
      const removed = model.groups
        .flatMap((g) => g.holdings)
        .find((h) => h.id === mutation.id);
      if (!removed) {
        return model;
      }
      const groups = model.groups.map((g) => ({
        ...g,
        holdings: g.holdings.filter((h) => h.id !== mutation.id),
      }));
      const entry = { id: removed.id, name: removed.name };
      const intoAssets = removed.direction === "asset";
      return {
        groups,
        trash: {
          assets: intoAssets ? [...model.trash.assets, entry] : model.trash.assets,
          liabilities: intoAssets
            ? model.trash.liabilities
            : [...model.trash.liabilities, entry],
        },
      };
    }
    case "hardDelete":
      return {
        groups: model.groups,
        trash: {
          assets: model.trash.assets.filter((e) => e.id !== mutation.id),
          liabilities: model.trash.liabilities.filter((e) => e.id !== mutation.id),
        },
      };
    case "emptyTrash":
      return { groups: model.groups, trash: { assets: [], liabilities: [] } };
    default:
      return model;
  }
}

/**
 * The base model with every pending mutation folded over it in order. The fold
 * order matters: a `delete` followed by `emptyTrash` both vanishes the row from
 * its pane and clears the trash it briefly landed in.
 */
export function applyBoardMutations(
  base: BoardModel,
  pending: readonly BoardMutation[],
): BoardModel {
  return pending.reduce(applyOne, base);
}
