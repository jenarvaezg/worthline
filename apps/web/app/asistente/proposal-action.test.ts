/**
 * Lifecycle tests for the assistant-proposal seam (PRD #1112 S4). These exercise
 * the SHELL the seam owns — the demo/impersonation write barrier, the draft
 * parse, and the read-proposal + validate-kind-and-state gate with its unified
 * message — once here, rather than re-testing it in every proposal-action file.
 * Each kind's own apply body keeps its dedicated test.
 */

import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
} from "@web/demo/write-guard";
import type { StoreTarget } from "@web/store-resolver";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  PROPOSAL_UNAVAILABLE_MESSAGE,
  PROPOSAL_UNRECOGNIZED_MESSAGE,
  runProposalConfirm,
  runProposalDiscard,
} from "./proposal-action";

// The guard reads the request-scoped store target; drive it directly.
let mockTarget: StoreTarget = { kind: "authenticated" } as StoreTarget;
vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => mockTarget,
}));

afterEach(() => {
  mockTarget = { kind: "authenticated" } as StoreTarget;
});

const okParse = (proposalId: string) => () =>
  ({ ok: true, proposalId, data: undefined }) as const;

async function seedDraft(kind: "correction" = "correction") {
  const store = await createInMemoryStore();
  const proposal = await store.assistantProposals.create({ kind });
  return { store, proposal };
}

const applyOk = async () => ({ status: "applied" as const, n: 1 });

describe("guard (shared by confirm + discard)", () => {
  test("a demo persona is blocked before any parse or write", async () => {
    mockTarget = { kind: "demo" } as StoreTarget;
    let parsed = false;
    const result = await runProposalConfirm({
      rawDraft: {},
      testArgs: [],
      kind: "correction",
      parse: () => {
        parsed = true;
        return { ok: true, proposalId: "x", data: undefined };
      },
      apply: applyOk,
    });
    expect(result).toEqual({ status: "blocked", message: DEMO_DISABLED_MESSAGE });
    expect(parsed).toBe(false);
  });

  test("an admin impersonation is blocked", async () => {
    mockTarget = {
      kind: "authenticated",
      impersonatedEmail: "owner@example.com",
    } as StoreTarget;
    const result = await runProposalDiscard({
      rawDraft: {},
      testArgs: [],
      kind: "correction",
      parse: okParse("x"),
    });
    expect(result).toEqual({
      status: "blocked",
      message: IMPERSONATION_READONLY_MESSAGE,
    });
  });
});

describe("runProposalConfirm", () => {
  test("a parse failure surfaces the caller's message, never opens the store", async () => {
    const result = await runProposalConfirm({
      rawDraft: null,
      testArgs: [],
      kind: "correction",
      parse: () => ({ ok: false, message: PROPOSAL_UNRECOGNIZED_MESSAGE }),
      apply: applyOk,
    });
    expect(result).toEqual({ status: "error", message: PROPOSAL_UNRECOGNIZED_MESSAGE });
  });

  test("an unknown proposal id fails with the unified unavailable message", async () => {
    const store = await createInMemoryStore();
    const result = await runProposalConfirm({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "correction",
      parse: okParse("missing"),
      apply: applyOk,
    });
    expect(result).toEqual({ status: "error", message: PROPOSAL_UNAVAILABLE_MESSAGE });
    store.close();
  });

  test("a wrong-kind proposal fails with the unified message (kind is enforced)", async () => {
    const { store, proposal } = await seedDraft("correction");
    const result = await runProposalConfirm({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "reconcile",
      parse: okParse(proposal.id),
      apply: applyOk,
    });
    expect(result).toEqual({ status: "error", message: PROPOSAL_UNAVAILABLE_MESSAGE });
    store.close();
  });

  test("an already-resolved proposal fails with the unified message", async () => {
    const { store, proposal } = await seedDraft("correction");
    await store.assistantProposals.markApplied(proposal.id);
    const result = await runProposalConfirm({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "correction",
      parse: okParse(proposal.id),
      apply: applyOk,
    });
    expect(result).toEqual({ status: "error", message: PROPOSAL_UNAVAILABLE_MESSAGE });
    store.close();
  });

  test("a live draft is handed to apply, which returns the applied payload", async () => {
    const { store, proposal } = await seedDraft("correction");
    let receivedId: string | undefined;
    const result = await runProposalConfirm({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "correction",
      parse: okParse(proposal.id),
      apply: async ({ proposal: live }) => {
        receivedId = live.id;
        return { status: "applied", n: 3 };
      },
    });
    expect(result).toEqual({ status: "applied", n: 3 });
    expect(receivedId).toBe(proposal.id);
    store.close();
  });
});

describe("runProposalDiscard", () => {
  test("a live draft is marked discarded", async () => {
    const { store, proposal } = await seedDraft("correction");
    const result = await runProposalDiscard({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "correction",
      parse: okParse(proposal.id),
    });
    expect(result).toEqual({ status: "discarded" });
    expect(await store.assistantProposals.read(proposal.id)).toMatchObject({
      status: "discarded",
    });
    store.close();
  });

  test("an unknown/resolved proposal fails with the unified message", async () => {
    const store = await createInMemoryStore();
    const result = await runProposalDiscard({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "correction",
      parse: okParse("missing"),
    });
    expect(result).toEqual({ status: "error", message: PROPOSAL_UNAVAILABLE_MESSAGE });
    store.close();
  });
});
