"use client";

/**
 * The board's optimistic shell (#521, S5 of #485, #1608; interaction-patterns
 * §4/§7/§8).
 *
 * The pure merge lives in `optimistic-board`; this is the React half that folds
 * an in-flight mutation over the server-rendered model and hands every form the
 * `onSubmit` that starts it. Deleting a row — and emptying / hard-deleting from
 * the trash — shows immediately; the redirect every action ends with re-renders
 * server truth and settles it, or, on the error redirect, reverts the optimistic
 * change while the error band surfaces (§4).
 *
 * The forms keep a plain server-action `action=` so they still work with JS off
 * (progressive enhancement); when JS is on, `onSubmit` intercepts to apply the
 * merge inside a transition, so React keeps `isPending` true until the redirect
 * lands. In demo (`readOnly`) the optimism is skipped (§10): the write-guard
 * rejects the action, so a faked-then-reverted change would only flicker.
 *
 * Extracted from the board so a mutation surface asks for its submit handler
 * instead of reaching into the island's closure — a new one (row, trash row,
 * whatever comes next) plugs in without the board growing a branch for it.
 */

import {
  applyBoardMutations,
  type BoardModel,
  type BoardMutation,
} from "@web/patrimonio/optimistic-board";
import type { TrashView } from "@worthline/db";
import type { PortfolioGroup } from "@worthline/domain";
import { type FormEvent, useOptimistic, useTransition } from "react";

/**
 * Build an `onSubmit` that applies the optimistic merge before invoking the server
 * action, all inside a transition so `useOptimistic` tracks it and React keeps the
 * saving state pending until the action's redirect lands. `undefined` in demo, where
 * the form falls back to the plain server-action post (no faked optimism, §10).
 */
export type OptimisticSubmit = (
  mutation: BoardMutation,
  action: (formData: FormData) => unknown,
) => ((event: FormEvent<HTMLFormElement>) => void) | undefined;

export interface OptimisticBoard {
  /** The server model with any in-flight mutation folded over it. */
  model: BoardModel;
  /** True while a mutation's transition has not settled — the `aria-live` copy (§8). */
  isPending: boolean;
  optimisticSubmit: OptimisticSubmit;
}

export function useOptimisticBoard({
  groups,
  trash,
  readOnly,
}: {
  groups: PortfolioGroup[];
  trash: TrashView;
  readOnly: boolean;
}): OptimisticBoard {
  const base: BoardModel = { groups, trash };
  const [model, addPending] = useOptimistic(
    base,
    (current: BoardModel, mutation: BoardMutation) =>
      applyBoardMutations(current, [mutation]),
  );
  const [isPending, startTransition] = useTransition();

  const optimisticSubmit: OptimisticSubmit = (mutation, action) => {
    if (readOnly) {
      return undefined;
    }
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      startTransition(async () => {
        addPending(mutation);
        await action(formData);
      });
    };
  };

  return { model, isPending, optimisticSubmit };
}
