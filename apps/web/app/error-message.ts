/**
 * The text of anything thrown, for a log line: an `Error`'s message, otherwise
 * its string form. Logs only — never a user-facing message, which must be
 * written for the person, not derived from an exception.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
