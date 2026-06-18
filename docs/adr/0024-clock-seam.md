# The action layer asks an injected clock for `today` and `now` instead of reading `new Date()`

ADR 0020 moved persist-and-ripple behind one store seam, and noted in passing
that each action still "re-derives `today` itself." It does: `today` is computed
inline as `new Date().toISOString().slice(0, 10)` at eighteen action sites — every
dated-fact handler in `patrimonio/actions.ts` (e.g. lines 665, 723, 799, 950,
1023, 1076, 1130, 1209, 1263, 1318, 1398, 1452, 1505, 1583), plus
`inversiones/actions.ts:132,289`, `create-holding-action.ts:256`, and
`intake/asset.ts:125`. A second, smaller use is the wall-clock **timestamp** —
`new Date().toISOString()` — for soft-delete tombstones (`patrimonio/actions.ts:67,98`,
`inversiones/actions.ts:430`, `ajustes/actions.ts:78`, `ajustes/numista-actions.ts:256`)
and the price-cache `nowIso` (`inversiones/actions.ts:83,545`).

The cost is testability. A backdated-fact test — "declare a valuation anchor
dated three months ago and assert the ripple touched the right snapshots" —
depends on what the action thinks `today` is, but the action reaches for the
real `Date`. The only lever a test has is module-level `Date` mocking
(`vi.setSystemTime` / `vi.useFakeTimers`), which the suite has so far avoided:
`createHoldingAction.test.ts` and friends drive actions through `runAction(fd, store)`
with an in-memory store and never touch the global clock. We do not want the
migration to introduce time mocking just to make `today` deterministic.

Note `Date.now()` in the action layer is a **different concern** and out of scope
here: it is a numeric _seed_ for `createStableId(prefix, name, seed)`
(`intake/shared.ts:69`), used to make ids unique, not to tell the time. It already
flows in as a plain argument to the strict parsers and is trivially fixed in tests
by passing a constant. The clock seam is only about `today` (a date-key) and `now`
(a timestamp).

The dependency direction is settled (ADR 0020): `domain` is pure, `db` orchestrates
over pure domain functions, `apps/web` actions parse-and-delegate. The store seam
**already accepts the current date as data** — `store.addValuationAnchorAndRipple(parsed.command, { today })`
(`patrimonio/actions.ts:694`) — so the clock value crosses the seam as an argument,
not as something the store re-derives. The clock is the action layer's input, and
the action is exactly where it should be injected.

## Decision

A `Clock` is a two-method interface the action layer asks for the current date,
and which tests replace with a fixed value:

```ts
// packages/domain/src/clock.ts
/** Today's date as a YYYY-MM-DD date-key (the form every dated fact, anchor,
 *  and snapshot already uses), and the current instant as an ISO-8601 string. */
export interface Clock {
  /** Local calendar day as a YYYY-MM-DD date-key. */
  today(): string;
  /** Current instant as a full ISO-8601 timestamp (for tombstones, price cache). */
  now(): string;
}
```

Two adapters, also in `packages/domain/src/clock.ts`:

```ts
/** Production adapter: reads the real wall clock. */
export function systemClock(): Clock {
  return {
    today: () => new Date().toISOString().slice(0, 10),
    now: () => new Date().toISOString(),
  };
}

/** Test adapter: every call returns the same frozen instant. Accepts an ISO
 *  string or a Date; `today()` is that instant's date-key, `now()` its ISO. */
export function fixedClock(instant: string | Date): Clock {
  const iso = (typeof instant === "string" ? new Date(instant) : instant).toISOString();
  return { today: () => iso.slice(0, 10), now: () => iso };
}
```

The clock rides the **same injection mechanism as the store**: a trailing optional
parameter that defaults to the production adapter. Actions already carry one
trailing optional injectable (`_store?: WorthlineStore`) and, in one place, a
second (`_provider?: PriceProvider`, `inversiones/actions.ts:542`), so a second
optional `_clock?: Clock` is the established shape — no new convention, fully
backward-compatible with every existing `runAction(fd, store)` call:

```ts
// before
export async function addValuationAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseValuationAnchorStrict(formData, id, Date.now(), today);
  // …
  store.addValuationAnchorAndRipple(parsed.command, { today });
}

// after
export async function addValuationAnchorAction(
  formData: FormData,
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
): Promise<never> {
  const today = _clock.today();
  const parsed = parseValuationAnchorStrict(formData, id, Date.now(), today);
  // …
  store.addValuationAnchorAndRipple(parsed.command, { today });
}
```

A test then writes `await addValuationAnchorAction(fd, store, fixedClock("2026-03-15"))`
and the whole backdated-ripple scenario is deterministic with no global `Date`
touched.

The interface and adapters live in **`domain`**, the package every layer already
imports and the home of the date-key vocabulary. `Clock` is a pure type plus two
factories; `systemClock` is the only thing that reads `new Date()`, and nothing in
`domain`'s pure recalculation functions imports it. This respects the dependency
direction: `domain` stays free of `db`, and the clock is a value the action layer
constructs and passes inward, exactly like `today` already is.

## Considered options

- **Clock as a second optional param `_clock?: Clock` (chosen).** Mirrors the
  existing `_store` / `_provider` injection one-to-one, keeps the clock at the
  layer that actually decides "now", and is a mechanical, backward-compatible
  migration.
- **Fold the clock into the store seam (`store.clock` or a combined
  `_deps?: { store; clock }`).** Rejected. The store is a _persistence_ seam; the
  current date is not its concern, and ADR 0020 deliberately has callers pass
  `today` _into_ store methods as data. Putting the clock inside the store would
  make the store re-derive a value it is currently handed, and would force a
  signature change on every store consumer, not just actions. A combined `_deps`
  object is a larger, non-mechanical migration that breaks every `runAction(fd, store)`
  call for no gain over a second optional param.
- **Module-level `Date` mocking in tests (`vi.useFakeTimers`).** Rejected — this is
  the status quo the issue exists to avoid: it is global, leaks across tests, and
  couples a backdated-fact assertion to timer plumbing instead of to an explicit input.
- **A single `today()` free function imported by actions, swapped via module mock.**
  Rejected. It trades inline `new Date()` for a hidden module dependency that still
  needs `vi.mock` to control — invisible at the call site and not injectable as data.
- **Put `Clock` in a new top-level `clock` package or in `db`.** Rejected. A new
  package is overkill for one interface and two factories; `db` is the wrong home
  because `domain` (which page-render paths like `dashboard.ts:202` also need a
  clock for) must not depend on `db`.

## Consequences

- The migration (#314) becomes mechanical: replace each `new Date().toISOString().slice(0, 10)`
  with `_clock.today()` and each tombstone/`nowIso` `new Date().toISOString()` with
  `_clock.now()`, and add `_clock: Clock = systemClock()` to each action signature.
- Backdated-fact tests pass `fixedClock("YYYY-MM-DD")` as the third argument; the
  suite keeps its no-global-`Date`-mocking property.
- The `Date.now()` id seed is explicitly **not** part of this seam; it stays a plain
  argument to the strict parsers and is left to a separate decision if it ever needs one.
- The two non-action wall-clock leaks in `domain` (`dashboard.ts:202`,
  `capture-snapshot.ts`'s `Date.now()` seed default) are now nameable against the
  same `Clock` and can be migrated opportunistically; this ADR scopes #314 to the
  action layer and does not require touching them.
- No new domain noun: "today" and "now" already name these values across the action
  layer. `Clock` is an implementation seam for them, in the spirit of ADR 0020's
  store seam — one place that owns "what time the action thinks it is."
