# The FIRE age is derived from a birth date, never typed

## Context

`currentAge` was a number in the FIRE settings form, and a number in the stored
config. Jorge typed **62**. His member profile already said `birth_year: 1963`, so in
August 2026 he was **63** — and the app still read 62, because nothing ever
re-derived it.

The age is not a label. It is the origin of every age the projection prints
(`fire.ts:274-291`):

```ts
const yearsToRetirement = targetRetirementAge - config.currentAge;
result.coastFireAge =
  config.currentAge + Math.log(fireNumberMinor / eligibleAssetsMinor) / Math.log(1 + rate);
```

Measured on his portfolio (#1415, found reviewing his FIRE page on 2026-08-17):

| Figure                     | Served (age 62) | Correct (age 63) |
| -------------------------- | --------------- | ---------------- |
| Coast age                  | 72,99           | 73,99            |
| Years to target retirement | 5               | 4                |
| `coastFireRequired`        | 577.262 €       | 597.492 €        |

One year of horizon he does not have compounds one extra year of growth into the
coast requirement, so the app told him he was **closer** to coast than he is. The
error is not a one-off: it grows by a year every year, always in the flattering
direction, and the three ages on the projection chart drift with it.

A stored age is a fact with an expiry date that nothing enforces. A birth date has
none.

## Decision

1. **The birth date is the only stored age fact.** `members.birth_year` plus the new
   `members.birth_month` (schema v55, nullable). The FIRE form has **no age field**:
   an input that is filled in and then ignored is worse than no input, and there is
   nothing left to fill in.

2. **The age is derived at the read, in one door.** `store.readFireConfig(todayISO?)`
   returns the stored configs with `currentAge` resolved from the scope members'
   birth dates (`withDerivedCurrentAges`). Every reader — the dashboard, /objetivos,
   /ajustes, the agent view, the MCP tools, the data-health engine — comes through
   that one function, so none of them can be the one that forgot. `todayISO` is a
   **required** parameter: the clock crosses that seam as an argument rather than
   being re-derived inside the store (ADR 0024), and an optional one is precisely
   how a reader ends up measuring the age on a second, disagreeing clock — making
   it required is what turns that mistake into a compile error.

3. **A scope takes its oldest active member.** In a household the oldest member's
   horizon binds first: fewer years of compounding before the target age, so a higher
   coast requirement. Taking the youngest would flatter the plan, which is the bug
   being replaced.

4. **The month is optional, and the imprecision is stated rather than faked.** With a
   month, the age is exact to the month (the birthday counts as passed for the whole
   of its month — we do not ask for the day). Without one, the age is
   `year − birthYear`: ±1 year inside the natural year, which beats a permanent
   one-year lie. Nothing is backfilled — a member who only gave a year genuinely does
   not know the month.

5. **`FireScopeConfig.currentAge` survives as a legacy fallback, and is protected on
   write.** Configs written before this change may be the only place a workspace's age
   lives. A scope with no derivable age keeps whatever its config carried, and
   `saveFireConfig` carries the legacy scalar forward when the incoming config omits
   it — otherwise saving an unrelated field would erase the age, and with it
   `coastFireRequired`, `coastFireAge` and `isAlreadyAtCoastFire`, silently.

## Alternatives considered

- **Keep the typed field and refresh it on save (rejected).** It only re-freezes on a
  newer year: a user who never reopens settings drifts exactly as before, and the
  drift is invisible precisely because the field looks filled in.
- **Show the derived age as a read-only field in settings (rejected).** Considered and
  dropped: it is a number the user cannot act on where it is shown. What settings does
  say is the one thing the user *can* act on — that **no** age can be derived, or that
  the age still in play came from an old config and is going stale.
- **Migrate every legacy `currentAge` into a member's `birth_year` (rejected).** For a
  one-member workspace it is a safe subtraction; for a household or group scope there
  is no member to attribute the age to, and guessing would write a birth year the user
  never gave. The fallback costs one branch and invents nothing.
- **Ask for the full birth date (rejected).** The day buys precision no FIRE figure
  can use — the projection steps in years — in exchange for a third field and a real
  date validation.
- **Derive the age inside `calculateFire` (rejected).** It would push a `Workspace` and
  a clock into the core math, which is pure and takes a config. Resolving at the read
  keeps the engine reading one field and keeps the derivation testable on its own.

## Consequences

- Schema v55: `members.birth_month` (1-12, nullable). Additive ALTER; existing rows
  read as "year only".
- `readFireConfig` now depends on the workspace (through the memoized
  `ctx.getWorkspace()`), so a FIRE read implies a membership read. `export` still
  writes the **stored** config, not the derived one — an export carries facts.
- `parseCalendarMonth` is the single door for the 1-12 range, shared by the form
  parser and the derivation — including the read date's own month, so a malformed
  `2026-00-01` cannot subtract a year either. The transfer schema keeps its own
  `min(1).max(12)`: that is the boundary validator, and it is meant to be
  independent.
- `parseBirthYear` stores only a year the derivation can read back. A `2100` kept
  as-is would sit in the profile looking filled in while `ageOnDate` refused it, so
  a workspace with no legacy age would lose the coast block AND be told by settings
  that it has no birth date at all. What the writer accepts is what the reader
  accepts.
- `resolveScopeMemberIds` gained a non-throwing sibling, `findScopeMemberIds`. Stored
  per-scope data can outlive the group it was keyed by, and a FIRE config for a
  deleted group must not crash a page.
- The agent view exposes `birthMonth` on the member profile and documents
  `currentAge` as derived, so the assistant can explain where an age came from
  instead of treating it as something the user typed.
- The demo personas got birth dates and lost their `currentAge`: the showcase should
  not display the very frozen age this removes. The e2e seed got birth dates for the
  same reason — without one there is no FIRE horizon, so every goal falls out of it
  and journey 37's delay-label assertion loses its subject.
- Not covered here: the `Edad Coast` label is conceptually wrong for a different
  reason (it is not the age at which you reach coast, and that age is computed
  nowhere) — that is #1425, and it edits the same lines of `fire.ts`.
