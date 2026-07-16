import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withAuthorizedStore: vi.fn(
    async (_principal: unknown, run: (store: unknown) => unknown) =>
      run({ tag: "store" }),
  ),
}));

vi.mock("@web/principal", () => ({
  withAuthorizedStore: mocks.withAuthorizedStore,
}));

import { runAgentViewStore } from "./agent-view-store";

describe("agent-view REST store runner", () => {
  test("enters the authorization port as a local principal", async () => {
    const seen: unknown[] = [];

    await runAgentViewStore((store) => {
      seen.push(store);
    });

    // The loopback + capability-token guard models a `local` principal: the read
    // enters through the port (#998 S2), never a raw DB open. The runner NEVER
    // constructs an `authenticated`/`system`/`demo` principal — those belong to
    // the request/cron surfaces, not the local AFK agent-view.
    expect(mocks.withAuthorizedStore).toHaveBeenCalledTimes(1);
    const [principal] = mocks.withAuthorizedStore.mock.calls[0]!;
    expect(principal).toEqual({ kind: "local" });
    expect(seen).toEqual([{ tag: "store" }]);
  });
});
