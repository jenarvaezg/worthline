/**
 * runCommand harness (#966): execute commands against in-memory store without
 * server actions.
 */

import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import type { CommandExecutor } from "./harness";
import { runCommand } from "./harness";
import type { CommandResult } from "./types";

const noopExecutor: CommandExecutor<{ label: string }, string> = async (
  _store,
  command,
) => ({ ok: true, value: command.label });

describe("runCommand", () => {
  test("creates and closes an in-memory store when none is injected", async () => {
    const result = await runCommand(noopExecutor, { label: "ok" });
    expect(result).toEqual({ ok: true, value: "ok" });
  });

  test("reuses an injected store and does not close it", async () => {
    const store = await createInMemoryStore();
    let closed = false;
    const originalClose = store.close.bind(store);
    store.close = () => {
      closed = true;
      originalClose();
    };

    const result = await runCommand(noopExecutor, { label: "injected" }, store);
    expect(result).toEqual({ ok: true, value: "injected" });
    expect(closed).toBe(false);

    store.close();
    expect(closed).toBe(true);
  });

  test("propagates executor failures as CommandResult", async () => {
    const failing: CommandExecutor<void, void> = async () => ({
      ok: false,
      error: "validation failed",
      code: "INVALID",
    });

    const result = await runCommand(failing, undefined);
    expect(result).toEqual({
      ok: false,
      error: "validation failed",
      code: "INVALID",
    });
  });

  test("passes the active store to the executor", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "m1", name: "Harness" }],
      mode: "individual",
    });

    const probe: CommandExecutor<void, string | undefined> = async (active) => {
      const workspace = await active.workspace.readWorkspace();
      return { ok: true, value: workspace?.members[0]?.name };
    };

    const result = await runCommand(probe, undefined, store);
    expect(result).toEqual({ ok: true, value: "Harness" });

    store.close();
  });
});
