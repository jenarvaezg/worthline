/**
 * The feedback action shell (#1174): the write guard runs first, only a signed-in
 * user's own session may send, the text is validated before anything is written,
 * and the outcome comes back as state — never as a redirect, which would lose the
 * draft (interaction-patterns §4.1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@web/demo/write-guard", () => ({ isWriteBlocked: vi.fn() }));
vi.mock("@web/read-store-target", () => ({
  readSessionEmail: vi.fn(),
  readStoreTarget: vi.fn(),
}));
vi.mock("@web/asistente/maintainer-alert-store", () => ({
  raiseMaintainerAlert: vi.fn(),
}));
vi.mock("@web/email/send-email", () => ({ sendEmail: vi.fn() }));

import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import { isWriteBlocked } from "@web/demo/write-guard";
import { sendEmail } from "@web/email/send-email";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";

import { FEEDBACK_IDLE } from "./feedback-message";
import { submitFeedbackAction } from "./submit-feedback-action";

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
