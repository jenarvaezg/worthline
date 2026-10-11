import { describe, expect, it } from "vitest";

import { maintainerAlertSubject } from "./missed-capture-alert";
import {
  buildUserFeedbackAlert,
  isUserFeedbackPayload,
  userFeedbackIdFromHoldingId,
} from "./user-feedback-alert";

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

    expect(first.holdingId).not.toBe(second.holdingId);
    expect(userFeedbackIdFromHoldingId(first.holdingId)).toBe("fb-1");
    expect(userFeedbackIdFromHoldingId("wl_hld_loan")).toBeNull();
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

describe("maintainerAlertSubject for feedback", () => {
  it("names the workspace and the message, never a holding", () => {
    const alert = buildUserFeedbackAlert(SUBMISSION);

    const subject = maintainerAlertSubject(alert);

    expect(subject.workspace).toBe("ws-ana");
    expect(subject.isFeedback).toBe(true);
    expect(subject.subject).toBe("mensaje del usuario");
    expect(subject.subject).not.toContain("feedback:");
  });
});
