/**
 * The viewer's refusal at every write door (#1843, ADR 0112). A session that
 * views a workspace someone SHARED with it is read-only: the one classifier
 * (`blockedWriteMessage`) answers with the viewer's message, and every door that
 * consults it — the `formAction` combinator, a guard written by hand, the
 * proposal combinators, `isWriteBlocked` — refuses before the store is touched.
 *
 * `readStoreTarget` is mocked with a canned viewer target: WHEN a request is a
 * viewer is `resolveStoreTarget`'s decision (`store-resolver.test.ts`) and the
 * cookie wiring's (`read-store-target-viewer.test.ts`). Here only what the gates
 * do with one.
 */

import type { StoreTarget } from "@web/store-resolver";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockTarget: StoreTarget = { kind: "local" };

vi.mock("@web/read-store-target", () => ({
  readSessionEmail: async () => "lucia@example.com",
  readStoreTarget: async () => mockTarget,
}));
vi.mock("@web/asistente/maintainer-alert-store", () => ({
  raiseMaintainerAlert: vi.fn(),
}));
vi.mock("@web/email/send-email", () => ({ sendEmail: vi.fn() }));

import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import { runProposalConfirm, runProposalDiscard } from "@web/asistente/proposal-action";
import { declineTrialRemindersAction } from "@web/correo/recordatorios/actions";
import {
  actsOnOwnAccount,
  blockedWriteMessage,
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
  isWriteBlocked,
  ownWorkspaceId,
  VIEWER_READONLY_MESSAGE,
  viewsSharedWorkspace,
  workspaceWriteBlockedMessage,
} from "@web/demo/write-guard";
import { sendEmail } from "@web/email/send-email";
import { FEEDBACK_IDLE } from "@web/feedback/feedback-message";
import { submitFeedbackAction } from "@web/feedback/submit-feedback-action";
import { updateInvestmentAction } from "@web/inversiones/update-investment-action";
import { deleteAssetAction } from "@web/patrimonio/actions";
import {
  DECLINE_IDLE,
  DECLINE_READ_ONLY_SESSION,
} from "@web/trial-emails/decline-trial-reminders";

const OWN: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws-lucia",
  dbUrl: "libsql://wl-lucia.turso.io",
  token: "full-lucia",
};

const VIEWER: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws-jorge",
  dbUrl: "libsql://wl-jorge.turso.io",
  token: "read-only-jorge",
  sharedByEmail: "jorge@example.com",
};

const IMPERSONATED: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws-jorge",
  dbUrl: "libsql://wl-jorge.turso.io",
  token: "full-jorge",
  impersonatedEmail: "jorge@example.com",
};

const DEMO: StoreTarget = { kind: "demo", persona: "familia", now: "" };

afterEach(() => {
  mockTarget = { kind: "local" };
  vi.clearAllMocks();
});

/** Run an action expecting it to throw redirect(); return the decoded digest. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const e = error as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return decodeURIComponent(e.digest.replace(/\+/g, " "));
    }
    throw error;
  }
  throw new Error("action did not redirect");
}

async function seedWorkspaceWithAsset(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "asset_keep",
    liquidityTier: "cash",
    name: "Caja",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "cash",
  });
  return store;
}

describe("the classifier (#1843)", () => {
  it("answers the viewer's message for a shared workspace", () => {
    expect(VIEWER_READONLY_MESSAGE).toBe(
      "Acceso de solo lectura: desde aquí no se puede cambiar nada de este espacio.",
    );
    expect(blockedWriteMessage(VIEWER)).toBe(VIEWER_READONLY_MESSAGE);
    expect(workspaceWriteBlockedMessage(VIEWER)).toBe(VIEWER_READONLY_MESSAGE);
  });

  it("keeps the demo and impersonation messages, and lets one's own workspace write", () => {
    expect(blockedWriteMessage(DEMO)).toBe(DEMO_DISABLED_MESSAGE);
    expect(blockedWriteMessage(IMPERSONATED)).toBe(IMPERSONATION_READONLY_MESSAGE);
    expect(blockedWriteMessage(OWN)).toBeNull();
    expect(blockedWriteMessage({ kind: "local" })).toBeNull();
  });

  it("acts on its own account only for one's own authenticated workspace", () => {
    expect(actsOnOwnAccount(OWN)).toBe(true);
    for (const target of [VIEWER, IMPERSONATED, DEMO, { kind: "local" } as StoreTarget]) {
      expect(actsOnOwnAccount(target)).toBe(false);
    }
    // The viewer never spends the owner's quota nor acts in their name.
    expect(ownWorkspaceId(VIEWER)).toBeNull();
    expect(ownWorkspaceId(OWN)).toBe("ws-lucia");
  });

  it("names the viewer session, and only it, as viewing a shared workspace", () => {
    expect(viewsSharedWorkspace(VIEWER)).toBe(true);
    for (const target of [OWN, IMPERSONATED, DEMO, { kind: "local" } as StoreTarget]) {
      expect(viewsSharedWorkspace(target)).toBe(false);
    }
  });
});

describe("Server Actions refuse the viewer (#1843)", () => {
  it("a formAction-built action redirects with the viewer message and leaves the store intact", async () => {
    const store = await seedWorkspaceWithAsset();
    mockTarget = VIEWER;
    const fd = new FormData();
    fd.set("id", "asset_keep");
    fd.set("currentUrl", "/patrimonio");

    expect(await redirectOf(() => deleteAssetAction(fd, store))).toContain(
      VIEWER_READONLY_MESSAGE,
    );
    const assets = await store.assets.readAssets();
    expect(assets.some((asset) => asset.id === "asset_keep")).toBe(true);
    store.close();
  });

  it("a hand-guarded action redirects with the viewer message and leaves the store intact", async () => {
    const store = await createInMemoryStore();
    const before = await store.assets.readAssets();
    mockTarget = VIEWER;
    const fd = new FormData();
    fd.set("currentUrl", "/inversiones/x/editar");
    fd.set("name", "Renombrado");

    expect(
      await redirectOf(() =>
        updateInvestmentAction("x", fd, store, fixedClock("2026-10-14")),
      ),
    ).toContain(VIEWER_READONLY_MESSAGE);
    expect(await store.assets.readAssets()).toEqual(before);
    store.close();
  });

  it("the proposal combinators answer blocked and the proposal stays a draft", async () => {
    const store = await createInMemoryStore();
    const proposal = await store.assistantProposals.create({ kind: "correction" });
    mockTarget = VIEWER;
    let applied = false;

    const confirmed = await runProposalConfirm({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "correction",
      parse: () => ({ ok: true, proposalId: proposal.id, data: undefined }),
      apply: async () => {
        applied = true;
        return { status: "applied" as const };
      },
    });
    const discarded = await runProposalDiscard({
      rawDraft: {},
      testArgs: [store as unknown as WorthlineStore],
      kind: "correction",
      parse: () => ({ ok: true, proposalId: proposal.id, data: undefined }),
    });

    expect(confirmed).toEqual({ status: "blocked", message: VIEWER_READONLY_MESSAGE });
    expect(discarded).toEqual({ status: "blocked", message: VIEWER_READONLY_MESSAGE });
    expect(applied).toBe(false);
    expect((await store.assistantProposals.read(proposal.id))?.status).toBe("draft");
    store.close();
  });

  it("isWriteBlocked refuses the viewer, so its silent doors write nothing", async () => {
    mockTarget = VIEWER;
    expect(await isWriteBlocked()).toBe(true);

    const reminders = new FormData();
    reminders.set("t", "any-token");
    expect(await declineTrialRemindersAction(DECLINE_IDLE, reminders)).toEqual({
      error: DECLINE_READ_ONLY_SESSION,
      status: "error",
    });

    const feedback = new FormData();
    feedback.set("message", "Esto no debería llegar a ningún sitio.");
    feedback.set("page", "/app");
    const sent = await submitFeedbackAction(FEEDBACK_IDLE, feedback);
    expect(sent.status).toBe("error");
    expect(raiseMaintainerAlert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
