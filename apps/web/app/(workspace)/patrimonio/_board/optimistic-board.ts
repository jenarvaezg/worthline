import type { TrashView } from "@worthline/db";
import { type BoardUnit, type PortfolioGroup, signedMinor } from "@worthline/domain";

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
 * Managed portfolio blocks (#1548) fold the same way: deleting a member
 * shrinks its block and its total, and the last member leaving takes the block
 * with it — never a header quoting a value nobody backs. What the merge does
 * NOT do is re-bucket: a block whose dominant rung changes because its largest
 * member left stays where the server put it until the redirect settles. Faking
 * a jump between subsections would be a guess about grouping, not an echo of
 * the click.
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

/**
 * One summand with a holding removed: the row itself vanishes, a portfolio
 * block loses one member (and its value), and a block left with nobody
 * vanishes too. Returns a list so a caller can `flatMap` the disappearance.
 */
function withoutHolding(unit: BoardUnit, holdingId: string): BoardUnit[] {
  if (unit.kind === "holding") {
    return unit.holding.id === holdingId ? [] : [unit];
  }
  const members = unit.members.filter((member) => member.id !== holdingId);
  if (members.length === unit.members.length) {
    return [unit];
  }
  if (members.length === 0) {
    return [];
  }
  return [
    {
      ...unit,
      members,
      signedMinor: members.reduce((acc, member) => acc + signedMinor(member), 0),
    },
  ];
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
      const groups = model.groups.map((g) => {
        const units = g.units.flatMap((unit) => withoutHolding(unit, mutation.id));
        return {
          ...g,
          // Rebuilt FROM the units so the flattened view can never disagree
          // with the summands it is supposed to be the flattening of.
          holdings: units.flatMap((u) =>
            u.kind === "holding" ? [u.holding] : u.members,
          ),
          units,
        };
      });
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
