/**
 * The clock seam (ADR 0024). The action layer asks an injected `Clock` for the
 * current date instead of reading `new Date()` inline. `today()` is a
 * `YYYY-MM-DD` date-key — the form every dated fact, anchor, and snapshot
 * already uses — and `now()` is the full ISO-8601 instant (for tombstones and
 * the price cache).
 *
 * `systemClock` is the only thing in `domain` that touches `new Date()`; none of
 * `domain`'s pure recalculation functions import it. Tests pass `fixedClock`
 * instead of mocking the global `Date`, keeping backdated-fact assertions
 * deterministic and explicit at the call site.
 */

import { asDateKey, asInstant, type DateKey, type Instant } from "./dates";

/** A two-method source of the current date the action layer injects. */
export interface Clock {
  /** Today's calendar day as a YYYY-MM-DD date-key. */
  today(): DateKey;
  /** The current instant as a full ISO-8601 timestamp. */
  now(): Instant;
}

/** Production adapter: reads the real wall clock on every call. */
export function systemClock(): Clock {
  return {
    today: () => asDateKey(new Date().toISOString().slice(0, 10)),
    now: () => asInstant(new Date().toISOString()),
  };
}

/**
 * Test adapter: every call returns the same frozen instant. Accepts an ISO
 * string or a Date; `today()` is that instant's date-key, `now()` its ISO.
 */
export function fixedClock(instant: string | Date): Clock {
  const iso = (typeof instant === "string" ? new Date(instant) : instant).toISOString();
  return { today: () => asDateKey(iso.slice(0, 10)), now: () => asInstant(iso) };
}
