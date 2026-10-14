/**
 * Trimmed and lower-cased: the one comparable form of an email address in the
 * control plane (#1841). The tenancy directory looks users up by it and the
 * sharing door compares owner, viewer and the list with it, so a stray capital
 * or trailing space never makes the same person two people.
 */
export function comparableEmail(email: string): string {
  return email.trim().toLowerCase();
}
