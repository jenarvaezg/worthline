import { after } from "next/server";
import { cache } from "react";

import { readStoreTarget } from "./read-store-target";
import { openStore, type WorthlineStore } from "./store";

function assertReachable(
  target: Awaited<ReturnType<typeof readStoreTarget>>,
): asserts target is Exclude<typeof target, { kind: "unauthenticated" }> {
  if (target.kind === "unauthenticated") {
    throw new Error("Store opened without authentication");
  }
}

/** One libSQL connection per RSC request; closed after the response (incl. Suspense). */
export const getRequestStore = cache(async (): Promise<WorthlineStore> => {
  const target = await readStoreTarget();
  assertReachable(target);
  const store = await openStore(target);
  after(() => {
    store.close();
  });
  return store;
});
