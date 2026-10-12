import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

/**
 * Concurrent units of work on a single store.
 *
 * `@libsql/client` 0.18's embedded client is a single-connection pool: an open
 * interactive transaction holds the only connection, so a sibling statement
 * through the base client rejects with `TRANSACTION_ACTIVE`. Store writes fired
 * together (the `Promise.all` seeding pattern) must flatten into one
 * interactive transaction — joiners wait for it to be established, and the
 * outer stays open until every joined unit of work has settled.
 */
describe("concurrent transactions on one store", () => {
  test("a Promise.all of investment creations all persist", async () => {
    const store = await createInMemoryStore();
    try {
      await store.workspace.initializeWorkspace({
        members: [{ id: "m", name: "Jose" }],
        mode: "individual",
      });

      const ids = ["fund_0", "fund_1", "fund_2", "fund_3", "fund_4", "fund_5"];
      await Promise.all(
        ids.map((id) =>
          store.assets.createInvestmentAsset({
            currency: "EUR",
            id,
            liquidityTier: "market",
            name: `Fondo ${id}`,
            ownership: [{ memberId: "m", shareBps: 10_000 }],
          }),
        ),
      );

      for (const id of ids) {
        const asset = await store.assets.readInvestmentAssetById(id);
        expect(asset?.id).toBe(id);
      }
    } finally {
      store.close();
    }
  });
});
