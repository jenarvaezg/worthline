import { AgentViewHttpError } from "./contract";

/** A decoded opaque pagination cursor: the date + public ID it points at. */
export interface DateIdCursor {
  date: string;
  id: string;
}

/** The stable sort key shared by every date-ordered agent-view collection. */
export interface DateIdKey {
  dateKey: string;
  publicId: string;
}

export type DateSort = "date" | "-date";

/**
 * Compare two date+id sort keys, honoring the sort direction (`-date` reverses).
 * Date is primary, the public ID breaks ties — a strict total order, so cursor
 * pagination over it never drops or repeats a row.
 */
export function compareDateId(a: DateIdKey, b: DateIdKey, sort: DateSort): number {
  const byDate = a.dateKey.localeCompare(b.dateKey);
  const base = byDate !== 0 ? byDate : a.publicId.localeCompare(b.publicId);
  return sort === "-date" ? -base : base;
}

/**
 * Drop every item up to and including the cursor's position in the active sort
 * order, leaving only the items that strictly follow it — so a page never
 * repeats or skips a row across cursors.
 */
export function dropAfterCursor<T>(
  sorted: T[],
  cursor: DateIdCursor,
  sort: DateSort,
  keyOf: (item: T) => DateIdKey,
): T[] {
  const cursorKey: DateIdKey = { dateKey: cursor.date, publicId: cursor.id };
  return sorted.filter((entry) => compareDateId(keyOf(entry), cursorKey, sort) > 0);
}

/** Encode a date+id sort key into an opaque, URL-safe cursor string. */
export function encodeCursor(date: string, id: string): string {
  return Buffer.from(JSON.stringify({ d: date, i: id })).toString("base64url");
}

/** Decode an opaque cursor; any malformed input is a `400 bad_request`. */
export function decodeCursor(cursor: string): DateIdCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { d?: unknown }).d !== "string" ||
    typeof (parsed as { i?: unknown }).i !== "string"
  ) {
    throw invalidCursor();
  }

  const record = parsed as { d: string; i: string };
  return { date: record.d, id: record.i };
}

function invalidCursor(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "bad_request",
    message: "Invalid cursor.",
    status: 400,
  });
}
