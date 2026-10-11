import { describe, expect, it, vi } from "vitest";

import { emailConfigFromEnv, RESEND_SANDBOX_FROM, sendEmail } from "./send-email";

const CONFIG = { apiKey: "re_test_key", from: "worthline <avisos@example.com>" };

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("emailConfigFromEnv", () => {
  it("is null without a Resend key — email is optional, never a boot failure", () => {
    expect(emailConfigFromEnv({})).toBeNull();
    expect(emailConfigFromEnv({ RESEND_API_KEY: "   " })).toBeNull();
  });

  it("reads the key and the sender, trimmed", () => {
    expect(
      emailConfigFromEnv({
        RESEND_API_KEY: " re_live ",
        WORTHLINE_EMAIL_FROM: " worthline <avisos@example.com> ",
      }),
    ).toEqual({ apiKey: "re_live", from: "worthline <avisos@example.com>" });
  });

  it("falls back to Resend's sandbox sender until a domain is verified", () => {
    // The sandbox sender only delivers to the Resend account owner's own address —
    // enough for a maintainer notification, not for mail to users (#1173).
    expect(emailConfigFromEnv({ RESEND_API_KEY: "re_live" })).toEqual({
      apiKey: "re_live",
      from: RESEND_SANDBOX_FROM,
    });
    expect(RESEND_SANDBOX_FROM).toContain("onboarding@resend.dev");
  });
});

describe("sendEmail", () => {
  it("skips without a key and never touches the network", async () => {
    const fetchImpl = vi.fn();

    const result = await sendEmail(
      { subject: "Hola", text: "cuerpo", to: "maintainer@example.com" },
      { env: {}, fetch: fetchImpl },
    );

    expect(result).toEqual({ reason: "not_configured", status: "skipped" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to the Resend send endpoint with the documented field names", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: "email-123" }));

    const result = await sendEmail(
      {
        idempotencyKey: "feedback-abc",
        replyTo: "usuario@example.com",
        subject: "Feedback",
        tags: [{ name: "kind", value: "user_feedback" }],
        text: "El texto tal cual",
        to: "maintainer@example.com",
      },
      { config: CONFIG, fetch: fetchImpl },
    );

    expect(result).toEqual({ id: "email-123", status: "sent" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
      "Idempotency-Key": "feedback-abc",
    });
    // REST names are snake_case (`reply_to`); camelCase is only the SDK's spelling.
    expect(JSON.parse(init.body)).toEqual({
      from: "worthline <avisos@example.com>",
      reply_to: "usuario@example.com",
      subject: "Feedback",
      tags: [{ name: "kind", value: "user_feedback" }],
      text: "El texto tal cual",
      to: ["maintainer@example.com"],
    });
  });

  it("omits the optional fields it was not given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: "email-1" }));

    await sendEmail(
      { subject: "S", text: "T", to: ["a@example.com", "b@example.com"] },
      { config: CONFIG, fetch: fetchImpl },
    );

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers).not.toHaveProperty("Idempotency-Key");
    expect(JSON.parse(init.body)).toEqual({
      from: CONFIG.from,
      subject: "S",
      text: "T",
      to: ["a@example.com", "b@example.com"],
    });
  });

  it("returns Resend's own error message instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "You can only send testing emails to your own email address.",
          name: "validation_error",
          statusCode: 403,
        }),
        { status: 403 },
      ),
    );

    const result = await sendEmail(
      { subject: "S", text: "T", to: "a@example.com" },
      { config: CONFIG, fetch: fetchImpl },
    );

    expect(result).toEqual({
      error:
        "validation_error: You can only send testing emails to your own email address.",
      httpStatus: 403,
      status: "failed",
    });
  });

  it("survives an error body that is not JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));

    const result = await sendEmail(
      { subject: "S", text: "T", to: "a@example.com" },
      { config: CONFIG, fetch: fetchImpl },
    );

    expect(result).toMatchObject({ httpStatus: 502, status: "failed" });
  });

  it("reports a network failure as failed, with no HTTP status", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const result = await sendEmail(
      { subject: "S", text: "T", to: "a@example.com" },
      { config: CONFIG, fetch: fetchImpl },
    );

    expect(result).toEqual({ error: "fetch failed", httpStatus: null, status: "failed" });
  });

  it("treats a 200 without an id as a failure, not as a sent email", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({}));

    const result = await sendEmail(
      { subject: "S", text: "T", to: "a@example.com" },
      { config: CONFIG, fetch: fetchImpl },
    );

    expect(result).toMatchObject({ httpStatus: 200, status: "failed" });
  });
});
