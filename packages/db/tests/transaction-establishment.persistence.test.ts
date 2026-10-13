import { openLibsqlClient } from "@db/libsql-client";
import { createStoreContext } from "@db/store-context";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * A unit of work whose interactive transaction cannot be opened (a Turso stream
 * error, a closed client) must fail through its own caller and nowhere else. The
 * establishment gate that joiners wait on must not turn that failure into a
 * second, unhandled rejection — in a plain Node or Bun process that kills it.
 */
describe("transaction establishment failure", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  test("rejects only through the caller, with no unhandled rejection", async () => {
    const client = openLibsqlClient(":memory:");
    try {
      client.transaction = () => Promise.reject(new Error("stream closed"));
      const ctx = createStoreContext(client, async () => null);

      await expect(ctx.transaction(async () => "never")).rejects.toThrow("stream closed");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("a joiner waiting on the gate still runs once establishment fails", async () => {
    const client = openLibsqlClient(":memory:");
    try {
      client.transaction = () => Promise.reject(new Error("stream closed"));
      const ctx = createStoreContext(client, async () => null);

      const [outer, joiner] = await Promise.allSettled([
        ctx.transaction(async () => "outer"),
        ctx.transaction(async () => "joiner"),
      ]);

      expect(outer.status).toBe("rejected");
      expect(joiner).toEqual({ status: "fulfilled", value: "joiner" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      client.close();
    }
  });
});
