import { describe, expect, it } from "vitest";

import { buildUserFeedbackAlert, isUserFeedbackPayload } from "./user-feedback-alert";

const SUBMISSION = {
  email: "usuario@example.com",
  feedbackId: "fb-1",
  message: "La ficha del inmueble no tiene campo de gastos.",
  page: "/patrimonio/wl_hld_casa/editar",
  submittedAt: "2026-10-11T10:00:00.000Z",
  workspaceId: "ws-ana",
};

describe("buildUserFeedbackAlert (#1174, ADR 0064)", () => {
  it("raises in the user's workspace, under the user_feedback category", () => {
    const alert = buildUserFeedbackAlert(SUBMISSION);

    expect(alert.workspaceId).toBe("ws-ana");
    expect(alert.category).toBe("user_feedback");
    expect(alert.occurredAt).toBe("2026-10-11T10:00:00.000Z");
  });

  it("gives every message its own subject, so two messages are two alerts", () => {
    // The dedup key is workspace + holding + category: with a per-workspace subject a
    // second, unrelated message would pile onto the first as an «occurrence», and
    // closing one would close both.
    const first = buildUserFeedbackAlert(SUBMISSION);
    const second = buildUserFeedbackAlert({ ...SUBMISSION, feedbackId: "fb-2" });

    expect(first.holdingId).toBe("feedback:fb-1");
    expect(second.holdingId).toBe("feedback:fb-2");
  });

  it("carries the message verbatim with what the maintainer needs to answer it", () => {
    const { payload } = buildUserFeedbackAlert(SUBMISSION);

    expect(payload).toEqual({
      category: "user_feedback",
      email: "usuario@example.com",
      message: "La ficha del inmueble no tiene campo de gastos.",
      page: "/patrimonio/wl_hld_casa/editar",
      submittedAt: "2026-10-11T10:00:00.000Z",
    });
    expect(isUserFeedbackPayload(payload)).toBe(true);
  });

  it("reads a stored payload defensively", () => {
    expect(isUserFeedbackPayload(null)).toBe(false);
    expect(isUserFeedbackPayload({ category: "user_feedback" })).toBe(false);
    expect(
      isUserFeedbackPayload({
        category: "user_feedback",
        email: null,
        message: "hola",
        page: null,
        submittedAt: "2026-10-11T10:00:00.000Z",
      }),
    ).toBe(true);
  });
});
