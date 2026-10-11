import { describe, expect, it, vi } from "vitest";

import { type DeliverFeedbackDeps, deliverFeedback } from "./deliver-feedback";

const SUBMISSION = {
  email: "usuario@example.com",
  feedbackId: "fb-1",
  message: "La ficha del inmueble no tiene campo de gastos.\nLo necesito para el FIRE.",
  page: "/patrimonio/wl_hld_casa/editar",
  submittedAt: "2026-10-11T10:00:00.000Z",
  workspaceId: "ws-ana",
};

function deps(overrides: Partial<DeliverFeedbackDeps> = {}): DeliverFeedbackDeps {
  return {
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    maintainerEmail: "maintainer@example.com",
    raiseAlert: vi.fn().mockResolvedValue({ alert: { id: "alert-9" } }),
    sendEmail: vi.fn().mockResolvedValue({ id: "email-1", status: "sent" }),
    siteUrl: "https://worthline.example",
    ...overrides,
  };
}

describe("deliverFeedback (#1174)", () => {
  it("writes the /admin alert and mails the maintainer — one submission, two destinations", async () => {
    const d = deps();

    const outcome = await deliverFeedback(SUBMISSION, d);

    expect(outcome).toEqual({ alert: "written", delivered: true, email: "sent" });
    expect(d.raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "user_feedback",
        holdingId: "feedback:fb-1",
        workspaceId: "ws-ana",
      }),
    );
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("mails the text verbatim, answerable by reply, linked to its /admin alert", async () => {
    const d = deps();

    await deliverFeedback(SUBMISSION, d);

    const email = vi.mocked(d.sendEmail).mock.calls[0]![0];
    expect(email.to).toBe("maintainer@example.com");
    expect(email.replyTo).toBe("usuario@example.com");
    expect(email.text).toContain(SUBMISSION.message);
    expect(email.text).toContain("/patrimonio/wl_hld_casa/editar");
    expect(email.text).toContain("ws-ana");
    expect(email.text).toContain("https://worthline.example/admin/alertas/alert-9");
    // A retried send must not mail twice: the key is the message's own id.
    expect(email.idempotencyKey).toBe("feedback-fb-1");
    expect(email.subject).toContain("La ficha del inmueble no tiene campo de gastos.");
    expect(email.subject).not.toContain("\n");
  });

  it("without a Resend key the alert is still written and the skip is logged", async () => {
    const d = deps({
      sendEmail: vi
        .fn()
        .mockResolvedValue({ reason: "not_configured", status: "skipped" }),
    });

    const outcome = await deliverFeedback(SUBMISSION, d);

    expect(outcome).toEqual({ alert: "written", delivered: true, email: "skipped" });
    expect(d.log.info).toHaveBeenCalledWith(
      expect.stringContaining("RESEND_API_KEY"),
      expect.objectContaining({ feedbackId: "fb-1" }),
    );
  });

  it("a mail failure never loses a feedback the alert already holds", async () => {
    const d = deps({
      sendEmail: vi.fn().mockResolvedValue({
        error: "rate_limit_exceeded",
        httpStatus: 429,
        status: "failed",
      }),
    });

    const outcome = await deliverFeedback(SUBMISSION, d);

    expect(outcome).toEqual({ alert: "written", delivered: true, email: "failed" });
    expect(d.log.error).toHaveBeenCalled();
  });

  it("with no maintainer address configured it skips the mail and says why", async () => {
    const d = deps({ maintainerEmail: null });

    const outcome = await deliverFeedback(SUBMISSION, d);

    expect(outcome).toEqual({ alert: "written", delivered: true, email: "no_recipient" });
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("WORTHLINE_ADMIN_EMAIL"),
      expect.anything(),
    );
  });

  it("still mails the maintainer when the control plane write throws", async () => {
    const d = deps({ raiseAlert: vi.fn().mockRejectedValue(new Error("libsql down")) });

    const outcome = await deliverFeedback(SUBMISSION, d);

    expect(outcome).toEqual({ alert: "failed", delivered: true, email: "sent" });
    const email = vi.mocked(d.sendEmail).mock.calls[0]![0];
    expect(email.text).toContain(SUBMISSION.message);
    expect(email.text).not.toContain("/admin/alertas/");
    expect(d.log.error).toHaveBeenCalled();
  });

  it("reports the feedback as NOT delivered when neither destination took it", async () => {
    const d = deps({
      raiseAlert: vi.fn().mockResolvedValue(null),
      sendEmail: vi
        .fn()
        .mockResolvedValue({ reason: "not_configured", status: "skipped" }),
    });

    const outcome = await deliverFeedback(SUBMISSION, d);

    expect(outcome).toEqual({ alert: "unavailable", delivered: false, email: "skipped" });
  });

  it("never writes the message itself into the server logs", async () => {
    const d = deps({ raiseAlert: vi.fn().mockRejectedValue(new Error("libsql down")) });

    await deliverFeedback(SUBMISSION, d);

    const logged = JSON.stringify([
      vi.mocked(d.log.error).mock.calls,
      vi.mocked(d.log.warn).mock.calls,
      vi.mocked(d.log.info).mock.calls,
    ]);
    expect(logged).not.toContain("campo de gastos");
  });
});
