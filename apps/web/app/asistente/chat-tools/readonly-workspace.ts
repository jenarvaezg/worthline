import type { AssistantProposalStore } from "@worthline/db";
import type { ToolSet } from "ai";

/**
 * The chat's read-only workspace (#1845): an admin impersonating a user may READ
 * through the assistant, but a turn of theirs must not leave drafts in that user's
 * workspace.
 *
 * Decided at ONE point, the store the tools receive, and not tool by tool: every
 * `propose_*` writes through `assistantProposals`, so a store whose writes refuse
 * closes all of them — including the next family, the day it is added. The refusal
 * is a typed error rather than an envelope because the store's contract returns a
 * proposal; {@link withWorkspaceReadonlyRefusal} turns it back into the answer the
 * model relays, once, over the whole tool set.
 */
export class WorkspaceReadonlyError extends Error {
  override readonly name = "WorkspaceReadonlyError";
}

/** The proposal store with its reads intact and every write refused with `message`. */
export function readonlyProposalStore(
  store: AssistantProposalStore,
  message: string,
): AssistantProposalStore {
  const refuse = (): never => {
    throw new WorkspaceReadonlyError(message);
  };
  return {
    read: store.read,
    create: async () => refuse(),
    appendDocument: async () => refuse(),
    markApplied: async () => refuse(),
    markDiscarded: async () => refuse(),
  };
}

/** What a tool answers when its write met the read-only store. */
export interface WorkspaceReadonlyRefusal {
  error: "workspace_readonly";
  message: string;
}

/**
 * Wrap the set so a tool whose write was refused answers with the read-only message
 * instead of failing the call. Any other error passes through untouched.
 */
export function withWorkspaceReadonlyRefusal(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      // Same loose signature as the provenance wrapper, for the same reason: a
      // wrapper agnostic about every tool's input and output.
      const execute = tool.execute as ToolExecute | undefined;
      if (!execute) return [name, tool];
      const wrapped: ToolExecute = async (input, options) => {
        try {
          return await execute(input, options);
        } catch (error) {
          if (error instanceof WorkspaceReadonlyError) {
            return {
              error: "workspace_readonly",
              message: error.message,
            } satisfies WorkspaceReadonlyRefusal;
          }
          throw error;
        }
      };
      return [name, { ...tool, execute: wrapped }];
    }),
  );
}

type ToolExecute = (input: unknown, options: unknown) => unknown;
