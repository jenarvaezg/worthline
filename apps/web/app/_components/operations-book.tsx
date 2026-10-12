"use client";

/**
 * An investment's operations, as both halves of the ficha see them (#1826).
 *
 * What used to be one operations editor is two pieces in two places now: the record
 * form lives in the ficha's side panel, the ledger in its «Operaciones» tab. They
 * still share one list, because recording is optimistic (#521, interaction-patterns
 * §4): the row the form just sent has to show in the ledger BEFORE the action
 * resolves, and a deleted row has to vanish from it the same way. So the list lives
 * here, above both, and each half reaches it through {@link useOperationsBook}.
 *
 * Only the ROW is faked — exactly what the user typed, folded by the pure
 * `applyOperationMutations`. The transition that holds it pending belongs to
 * whoever started it (the form records, the ledger deletes); `useOptimistic` keeps
 * the row for as long as that transition runs, wherever it was started.
 */

import type { InvestmentOperation } from "@worthline/domain";
import { createContext, type ReactNode, useContext, useOptimistic } from "react";
import { applyOperationMutations, type OperationMutation } from "./optimistic-operations";

interface OperationsBook {
  /** The ledger as the server read it, with every in-flight mutation folded over. */
  operations: readonly InvestmentOperation[];
  /** Apply a mutation optimistically. Call it inside the transition that runs the action. */
  addPending: (mutation: OperationMutation) => void;
}

const OperationsBookContext = createContext<OperationsBook | null>(null);

export function OperationsBookProvider({
  children,
  operations,
}: {
  children: ReactNode;
  /** The holding's operations, as the server read them. */
  operations: readonly InvestmentOperation[];
}) {
  const [optimistic, addPending] = useOptimistic(
    operations,
    (current: readonly InvestmentOperation[], mutation: OperationMutation) =>
      applyOperationMutations(current, [mutation]),
  );

  return (
    <OperationsBookContext.Provider value={{ addPending, operations: optimistic }}>
      {children}
    </OperationsBookContext.Provider>
  );
}

/** The shared book. Both halves sit under one provider; outside it is a wiring bug. */
export function useOperationsBook(): OperationsBook {
  const book = useContext(OperationsBookContext);
  if (book === null) {
    throw new Error("useOperationsBook needs an <OperationsBookProvider> above it.");
  }
  return book;
}
