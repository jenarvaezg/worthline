/**
 * The ONE apply gate for assistant proposals (#1591). What is asserted here is
 * the ceremony every kind shares — kind must match, draft must still be a draft,
 * resolution happens in the same transaction as the write — so the per-kind tests
 * (statement, mixed, reconcile, corrección, traspaso…) can keep asserting what
 * their own write does and nothing else.
 */

import type { AssistantProposalApplyKind, WorthlineStore } from "@worthline/db";
import { ASSISTANT_PROPOSAL_APPLY_KINDS, createInMemoryStore } from "@worthline/db";
import { beforeEach, describe, expect, test } from "vitest";

const TODAY = "2026-08-26";

/**
 * The gate refuses on identity — kind, existence, status — BEFORE it reaches the
 * row that would need the rest of the params, so a refusal test can call it with
 * the id alone. That is what this narrowed view says, and nothing more.
 */
type ApplyById = (params: {
  kind: AssistantProposalApplyKind;
  proposalId: string;
}) => Promise<unknown>;

let store: WorthlineStore;

beforeEach(async () => {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jose" }],
    mode: "individual",
  });
});

describe("applyAssistantProposal", () => {
  test("refuses a proposal id that does not exist", async () => {
    await expect(
      store.command.applyAssistantProposal({
        funds: [],
        kind: "statement_import",
        proposalId: "wl_prop_missing",
        today: TODAY,
      }),
    ).rejects.toThrow(/was not found/);
  });

  test("refuses a draft of another kind", async () => {
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });

    await expect(
      store.command.applyAssistantProposal({
        funds: [],
        kind: "reconcile",
        proposalId: proposal.id,
        today: TODAY,
      }),
    ).rejects.toThrow(/is not a reconcile/);
    // Nothing was resolved: the draft survives for the caller that owns it.
    expect(await store.assistantProposals.read(proposal.id)).toMatchObject({
      status: "draft",
    });
  });

  test("applies a draft once and refuses the second attempt", async () => {
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });

    await store.command.applyAssistantProposal({
      funds: [],
      kind: "statement_import",
      proposalId: proposal.id,
      today: TODAY,
    });
    expect(await store.assistantProposals.read(proposal.id)).toMatchObject({
      status: "applied",
    });

    await expect(
      store.command.applyAssistantProposal({
        funds: [],
        kind: "statement_import",
        proposalId: proposal.id,
        today: TODAY,
      }),
    ).rejects.toThrow(/already resolved as applied/);
  });

  test("refuses a discarded draft", async () => {
    const proposal = await store.assistantProposals.create({ kind: "statement_import" });
    await store.assistantProposals.markDiscarded(proposal.id);

    await expect(
      store.command.applyAssistantProposal({
        funds: [],
        kind: "statement_import",
        proposalId: proposal.id,
        today: TODAY,
      }),
    ).rejects.toThrow(/already resolved as discarded/);
  });

  // Adding a kind is adding a ROW: every kind the gate knows gets the same
  // ceremony, with no per-kind method to forget to write it into.
  test.each(
    ASSISTANT_PROPOSAL_APPLY_KINDS,
  )("%s has a handler and shares the resolved-draft refusal", async (kind) => {
    const proposal = await store.assistantProposals.create({ kind });
    await store.assistantProposals.markApplied(proposal.id);
    const applyById = store.command.applyAssistantProposal as ApplyById;

    await expect(applyById({ kind, proposalId: proposal.id })).rejects.toThrow(
      /already resolved as applied/,
    );
  });
});
