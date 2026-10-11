import { describe, expect, test } from "vitest";

import {
  reminderOptOutSecret,
  signReminderOptOutToken,
  verifyReminderOptOutToken,
} from "./reminder-opt-out-token";

const SECRET = "test-secret-not-a-real-one";

describe("the «no recibir recordatorios» link token (#1173)", () => {
  test("names the identity it was signed for", () => {
    const token = signReminderOptOutToken("user-1", SECRET);
    expect(verifyReminderOptOutToken(token, SECRET)).toBe("user-1");
  });

  test("is URL-safe as is, so it travels in a query string without escaping", () => {
    const token = signReminderOptOutToken("6f1c2a9e-1b7d-4d8e-9f00-aa11bb22cc33", SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test("rejects a token pointed at someone else: the signature covers the identity", () => {
    const [, signature] = signReminderOptOutToken("user-1", SECRET).split(".");
    const forged = `${Buffer.from("user-2").toString("base64url")}.${signature}`;
    expect(verifyReminderOptOutToken(forged, SECRET)).toBeNull();
  });

  test("with no secret no token is valid: there is nothing to check it against", () => {
    expect(
      verifyReminderOptOutToken(signReminderOptOutToken("user-1", SECRET), null),
    ).toBeNull();
  });

  test("the key is AUTH_SECRET, read in one place; blank counts as absent", () => {
    expect(reminderOptOutSecret({ AUTH_SECRET: " s3cr3t " })).toBe("s3cr3t");
    expect(reminderOptOutSecret({ AUTH_SECRET: "  " })).toBeNull();
    expect(reminderOptOutSecret({})).toBeNull();
  });

  test("rejects a token signed with another secret", () => {
    const token = signReminderOptOutToken("user-1", "another-secret");
    expect(verifyReminderOptOutToken(token, SECRET)).toBeNull();
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["without a signature", "dXNlci0x"],
    ["with an empty identity", ".abc"],
    ["truncated", signReminderOptOutToken("user-1", SECRET).slice(0, -4)],
    ["with three parts", `${signReminderOptOutToken("user-1", SECRET)}.extra`],
  ])("rejects a malformed token (%s)", (_label, token) => {
    expect(verifyReminderOptOutToken(token, SECRET)).toBeNull();
  });
});
