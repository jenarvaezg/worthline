/**
 * A JSON blob worthline stored itself (sealed credentials, a pass's outcome, a
 * saved read), validated at the boundary with its schema. Nothing stored is null;
 * a blob that does not parse or does not fit is also null, because every caller
 * treats it as absent, but it leaves a server log saying which blob and which
 * fields, never its content: these blobs carry passwords and the user's figures.
 * Client-safe: no store.
 */
import type { z } from "zod";

export function readStoredJson<T>(
  schema: z.ZodType<T>,
  json: string | null,
  what: string,
): T | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // The parser's message quotes the text it choked on: it is not logged.
    console.warn("[stored-json] unreadable blob, treated as absent", {
      reason: "not_json",
      what,
    });
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn("[stored-json] unreadable blob, treated as absent", {
    issues: parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
    })),
    reason: "schema",
    what,
  });
  return null;
}
