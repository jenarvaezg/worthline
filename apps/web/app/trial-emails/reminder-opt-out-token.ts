import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The token in the «no recibir recordatorios» link of the trial emails (#1173).
 *
 * An honest opt-out works from the email itself, with no sign-in in between:
 * the link carries the identity and an HMAC over it, so the page can act for
 * exactly that identity and nobody can forge a link for another. It does not
 * expire — an unsubscribe link that stops working is not honest — and it grants
 * nothing but this one preference.
 *
 * The key is the deployment's `AUTH_SECRET`, already mandatory in production
 * (`production-config.ts`), separated from Auth.js's own use by the purpose
 * label below. Rotating that secret invalidates old links; the page then says
 * so and points at the contact address.
 */

const PURPOSE = "worthline:trial-reminders-opt-out:v1";

/** The public page the link opens (no session: the token is the credential). */
export const REMINDER_OPT_OUT_PATH = "/correo/recordatorios";

/** The query parameter that carries the token. */
export const REMINDER_OPT_OUT_PARAM = "t";

/** The absolute «no recibir recordatorios» link for one identity. */
export function reminderOptOutUrl(
  siteUrl: string,
  userId: string,
  secret: string,
): string {
  return `${siteUrl}${REMINDER_OPT_OUT_PATH}?${REMINDER_OPT_OUT_PARAM}=${signReminderOptOutToken(userId, secret)}`;
}

function signature(userId: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${PURPOSE}:${userId}`).digest();
}

export function signReminderOptOutToken(userId: string, secret: string): string {
  const identity = Buffer.from(userId, "utf8").toString("base64url");
  return `${identity}.${signature(userId, secret).toString("base64url")}`;
}

/** The identity the token was signed for, or null when it is not a valid token. */
export function verifyReminderOptOutToken(
  token: string | null | undefined,
  secret: string,
): string | null {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 2) return null;
  const [identity, supplied] = parts as [string, string];
  if (!identity || !supplied) return null;

  const userId = Buffer.from(identity, "base64url").toString("utf8");
  if (!userId) return null;
  const expected = signature(userId, secret);
  const given = Buffer.from(supplied, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? userId
    : null;
}
