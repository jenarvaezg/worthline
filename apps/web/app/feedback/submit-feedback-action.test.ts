/**
 * The feedback action shell (#1174): the write guard runs first, only a signed-in
 * user's own session may send, the text is validated before anything is written,
 * and the outcome comes back as state — never as a redirect, which would lose the
 * draft (interaction-patterns §4.1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub only the request-reading guard; keep the real pure classifier, which
// `canSendFeedback` asks (#1843).
vi.mock("@web/demo/write-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/demo/write-guard")>()),
  isWriteBlocked: vi.fn(),
}));
vi.mock("@web/read-store-target", () => ({
  readSessionEmail: vi.fn(),
  readStoreTarget: vi.fn(),
}));
vi.mock("@web/asistente/maintainer-alert-store", () => ({
  raiseMaintainerAlert: vi.fn(),
}));
vi.mock("@web/email/send-email", () => ({ sendEmail: vi.fn() }));
vi.mock("./feedback-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./feedback-rate-limit")>()),
  admitFeedbackSend: vi.fn(),
}));

import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import { isWriteBlocked } from "@web/demo/write-guard";
import { sendEmail } from "@web/email/send-email";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";

import { FEEDBACK_IDLE } from "./feedback-message";
import { admitFeedbackSend, FEEDBACK_RATE_LIMITED_MESSAGE } from "./feedback-rate-limit";
import { feedbackAvailableAction, submitFeedbackAction } from "./submit-feedback-action";

const AUTHENTICATED = {
  dbUrl: "libsql://ws-ana.example",
  kind: "authenticated" as const,
  token: "token",
  workspaceId: "ws-ana",
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("submitFeedbackAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WORTHLINE_ADMIN_EMAIL", "maintainer@example.com");
    vi.mocked(isWriteBlocked).mockResolvedValue(false);
    vi.mocked(readStoreTarget).mockResolvedValue(AUTHENTICATED);
    vi.mocked(readSessionEmail).mockResolvedValue("usuario@example.com");
    vi.mocked(raiseMaintainerAlert).mockResolvedValue({
      // biome-ignore lint/suspicious/noExplicitAny: only the id is read
      alert: { id: "alert-1" } as any,
      created: true,
    });
    vi.mocked(sendEmail).mockResolvedValue({ id: "email-1", status: "sent" });
    vi.mocked(admitFeedbackSend).mockResolvedValue("ok");
  });

  it("sends a signed-in user's message to both destinations", async () => {
    const state = await submitFeedbackAction(
      FEEDBACK_IDLE,
      form({
        message: "  No encuentro dónde meter los gastos.  ",
        page: "/objetivos?x=1",
      }),
    );

    expect(state).toEqual({ status: "sent" });
    expect(raiseMaintainerAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "user_feedback",
        payload: expect.objectContaining({
          email: "usuario@example.com",
          message: "No encuentro dónde meter los gastos.",
          page: "/objetivos",
        }),
        workspaceId: "ws-ana",
      }),
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: "usuario@example.com",
        to: "maintainer@example.com",
      }),
    );
  });

  it("keeps the client's draft id, so a retry lands on the same alert and email key", async () => {
    const draftId = "0f8fad5b-d9cb-469f-a165-70867728950e";

    await submitFeedbackAction(
      FEEDBACK_IDLE,
      form({ feedbackId: draftId, message: "hola" }),
    );

    expect(raiseMaintainerAlert).toHaveBeenCalledWith(
      expect.objectContaining({ holdingId: `feedback:${draftId}` }),
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `feedback:${draftId}` }),
    );
  });

  it("mints its own id when the client sent none or a malformed one", async () => {
    await submitFeedbackAction(
      FEEDBACK_IDLE,
      form({ feedbackId: "../x", message: "hola" }),
    );

    const { holdingId } = vi.mocked(raiseMaintainerAlert).mock.calls[0]![0];
    expect(holdingId).toMatch(/^feedback:[0-9a-f-]{36}$/);
  });

  it("refuses a send over the hourly limit, honestly and before writing anything", async () => {
    vi.mocked(admitFeedbackSend).mockResolvedValue("limited");

    const state = await submitFeedbackAction(FEEDBACK_IDLE, form({ message: "hola" }));

    expect(state).toEqual({ error: FEEDBACK_RATE_LIMITED_MESSAGE, status: "error" });
    expect(admitFeedbackSend).toHaveBeenCalledWith("ws-ana");
    expect(raiseMaintainerAlert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not spend the hourly allowance on a message it refuses as invalid", async () => {
    await submitFeedbackAction(FEEDBACK_IDLE, form({ message: "   " }));

    expect(admitFeedbackSend).not.toHaveBeenCalled();
  });

  it("refuses a blocked write (demo, impersonation) before touching anything", async () => {
    vi.mocked(isWriteBlocked).mockResolvedValue(true);

    const state = await submitFeedbackAction(FEEDBACK_IDLE, form({ message: "hola" }));

    expect(state.status).toBe("error");
    expect(raiseMaintainerAlert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses a request with no signed-in workspace", async () => {
    vi.mocked(readStoreTarget).mockResolvedValue({ kind: "local" });

    const state = await submitFeedbackAction(FEEDBACK_IDLE, form({ message: "hola" }));

    expect(state).toEqual({
      error: expect.stringMatching(/sesión/),
      status: "error",
    });
    expect(raiseMaintainerAlert).not.toHaveBeenCalled();
  });

  it("refuses an empty message without writing", async () => {
    const state = await submitFeedbackAction(FEEDBACK_IDLE, form({ message: "   " }));

    expect(state.status).toBe("error");
    expect(raiseMaintainerAlert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("says so when the message reached neither destination", async () => {
    vi.mocked(raiseMaintainerAlert).mockRejectedValue(new Error("down"));
    vi.mocked(sendEmail).mockResolvedValue({
      reason: "not_configured",
      status: "skipped",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    const state = await submitFeedbackAction(FEEDBACK_IDLE, form({ message: "hola" }));

    expect(state).toEqual({
      error: expect.stringMatching(/no se ha podido enviar/i),
      status: "error",
    });
  });
});

describe("feedbackAvailableAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isWriteBlocked).mockResolvedValue(false);
    vi.mocked(readStoreTarget).mockResolvedValue(AUTHENTICATED);
  });

  it("answers true for a signed-in user's own session", async () => {
    expect(await feedbackAvailableAction()).toBe(true);
  });

  it("answers false for a read-only session and for one with no workspace", async () => {
    vi.mocked(isWriteBlocked).mockResolvedValueOnce(true);
    expect(await feedbackAvailableAction()).toBe(false);

    vi.mocked(readStoreTarget).mockResolvedValueOnce({ kind: "local" });
    expect(await feedbackAvailableAction()).toBe(false);
  });

  it("answers false, and logs, when the session cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readStoreTarget).mockRejectedValueOnce(new Error("auth down"));

    expect(await feedbackAvailableAction()).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});
