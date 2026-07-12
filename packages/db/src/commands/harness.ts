import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/store-types";
import type { CommandResult } from "./types";

export type CommandExecutor<C, R> = (
  store: WorthlineStore,
  command: C,
) => Promise<CommandResult<R>>;

/**
 * Run a command executor against an in-memory store without server actions.
 * When `store` is omitted the harness creates and closes its own database.
 */
export async function runCommand<C, R>(
  executor: CommandExecutor<C, R>,
  command: C,
  store?: WorthlineStore,
): Promise<CommandResult<R>> {
  const owned = store === undefined;
  const activeStore = store ?? (await createInMemoryStore());

  try {
    return await executor(activeStore, command);
  } finally {
    if (owned) {
      activeStore.close();
    }
  }
}
