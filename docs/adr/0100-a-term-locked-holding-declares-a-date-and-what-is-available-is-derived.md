# A term-locked holding declares a DATE, and what is available is derived from it

## Context

The liquidity ladder (ADR 0013) defines `term-locked` as *«locked until a date or an
age»*. That date did not exist in the model: there was no column for it on `assets` or
anywhere else. The rung asserted that there was a plazo and could never say which one.

So a pension plan was a **block**, and both of the only two available answers were
false. Counting it whole as sellable capital promises money the owner cannot touch;
taking it out whole hides money that is already withdrawable. Since 2025 a Spanish
partícipe can redeem contributions older than ten years, so a live plan is almost
always **two things at once** — a tranche already available and a tranche not yet.

The tempting fix is to read the seniority off the ledger: `asset_operations` has a date
per row, so summing what went in before today-minus-ten-years looks trivial. **It is
not, and on the real portfolio it fails with names and dates attached.** Both pension
entries there are capital *movilizado* from another provider (#1518):

| Row                                    | Date in the book | Amount     | What it actually is    |
| -------------------------------------- | ---------------- | ---------: | ---------------------- |
| `op_n5396_traspaso_externo_20251205`   | 2025-12-05       | 4.979,55 € | alta by external transfer |
| `op_n5459_traspaso_externo_20260123`   | 2026-01-23       |    95,46 € | alta by external transfer |

A movilización inherits the seniority of the contributions that generated it, and those
contributions are **outside the book**. Deriving from the row date would print
«bloqueado hasta 2035» over money that may be redeemable today — inventing in the
direction opposite to the bug, through the same door as #1490 (an apertura does not
carry the real purchase date).

The second temptation is to store what is available *now*, in euros. That figure
expires every year and nobody revalidates it: the exact failure mode of #1415, which
ADR 0074 exists to forbid.

## Decision

**A term-locked holding declares ONE date — `assets.available_from` — and never an
amount. What is available is derived at read time, against the day the caller brings.
The only figure that changes is the depletion half of the sustainable spending; the
FIRE number, the perpetual half and every figure of today stay exactly as they were.**

1. **A date, because a date cannot expire.** `available_from` is nullable with **no
   backfill**, and null reads as «nobody has said». No date is ever derived from a
   ledger row — not from a movilización, not from an apertura. The seam
   (`setAvailableFrom`) refuses any holding that is not on the `term-locked` rung, the
   one ADR 0013 defines with a plazo; changing rung leaves an existing declaration
   **inert rather than wrong**, and moving back recovers it as declared.

2. **The declaration is collected by the loop that already decides eligibility.**
   `assembleFireEligiblePool` emits `declaredAvailability` (scope-owned, eligible,
   term-locked, with a date) and `undeclaredTermLockedMinor` (the same, without one).
   A second pass over the assets would be a second engine, and two engines with no
   confrontation is how #1438 produced 266 bad snapshots.

3. **The bite is one rule: no year spends what that year cannot touch.** The depletion
   annuity becomes the **smallest** level payment satisfying every horizon at once —
   for each `k`, what is withdrawn over the first `k` years must fit inside the capital
   released by then. Because availability is a step function, only the year before each
   release and the full horizon need checking. With no declaration the set of
   constraints collapses to the full horizon and the arithmetic is byte-identical to
   what shipped: **nobody's figure moves by a cent** (`availabilityAwareAnnuity`).

4. **Only the half with a calendar.** The perpetual version never touches the principal
   and the FIRE number does not distribute by year, so neither can be asked «where does
   year 3's money come from». Extending the lock to them would be inventing the third
   column of the split that #1523 explicitly rejects.

5. **The clock comes from the caller.** `calculateFireForScope` takes `todayISO` in its
   options (falling back to `rents.todayISO`, which is the same day of the same screen),
   because the domain does not read the clock (ADR 0024). Without a day nothing is
   resolved, and the result carries two fields that say so out loud: `resolved: false`,
   and `declaredMinor` — the declared total, which needs no clock. The sustainable-spending
   card reads both and prints «hay X declarado que no he situado en el calendario»
   **before** either of its other two sentences. A screen must not be able to print «no
   locks» when what happened is that nobody looked at a clock, and a field nothing reads
   would not have prevented that.

6. **The gap is named, not silenced.** Term-locked capital with no declared date is
   neither zero nor a lock: the reparto counts it as available from year one, and both
   the holding's ficha and the sustainable-spending card say so, with where to fix it.
   Silence there is the liquidity illusion #1447 exists to kill.

7. **Both figures on the card share one base.** `lockedMinor` and `undeclaredMinor` are
   printed in the same card, so both are capped against the **net** sellable side — the
   undeclared one against what is left of it after the lock. On two different bases an
   indebted scope could read more «a plazo sin fecha» than its whole sellable side, which
   is a figure the card's own arithmetic contradicts (ADR 0077).

## Consequences

- ADR 0013 carries an amendment saying the rung owns the field, so the rung's own ADR is
  no longer a definition with nowhere to store half of itself.
- The declaration rides the workspace transfer document (ADR 0010/0015). It is a fact only
  its owner can state and nothing can re-derive: losing it on a restore would silently turn
  locked capital into money available from year one.
- A holding on the `term-locked` rung gets an availability surface on its ficha
  (`_chrome/availability-panel`), keyed on the **rung** and not on a family (ADR 0095):
  a pension plan, a term deposit and a fund with a redemption window are valued three
  different ways and share this question whole.
- The declared amount available is never persisted, so it can never go stale. The cost
  is that every read resolves it — which is cheap, and is the point.
- **This is phase 1.** One date per holding covers «locked until 65» entirely. The plan
  that is genuinely a ladder needs per-lot dates (`contribution_lots`, #1676). Its input
  now exists: `asset_operations.transfer_seniority_at` (#1518, ADR 0083 amendment) landed
  alongside this work and carries the inherited seniority a transferred-in row could never
  derive from `executed_at`.
  What phase 2 must not do is treat that column as an availability date. Seniority says
  when the capital *started counting its age*; availability is what the redemption window
  turns that into, and going from one to the other needs the norm plus a per-lot split —
  which is exactly the work #1676 is, and exactly why phase 1 does not attempt it.
  A lot split there is about **liquidity, never fiscal basis**: the cost stays average, not
  FIFO, and any reader that reconstructs FIFO from such lots invents descuadres.
- `sideOfTier` is untouched: which column `term-locked` occupies is #1523's decision,
  and it is orthogonal to this one. This ADR says *how much* is available and *from
  when*; that one says which side the rest sits on.

## Amendment (#1676): phase 2 — the ladder, and where the redemption window lives

Phase 1 asked «from when?» once. A pension plan in progress is usually two things at once,
so `contribution_lots(asset_id, available_from, amount_minor)` now lets a holding declare
several tranches. Four decisions are worth recording, because each one had a tempting
alternative.

**A lot declares an availability date, not a contribution date.** The issue's shape left
`contribution_date | liquidity_date` open. Storing the contribution date would force the
engine to apply the ten-year window to derive anything, putting a legal rule inside the FIRE
calculation — a rule that can change, over capital the owner never declared as blocked. The
lot stores the day the money can be touched, exactly like phase 1's single date, and the
engine stays ignorant of what a fiscal year is.

**The window is an interface suggestion, never a derivation.** When a holding carries
inherited seniority (#1518), the ficha PRE-FILLS the lot date with seniority + ten years and
says where the figure comes from; the owner confirms or corrects it, and what is stored is
his declaration. `PENSION_LIQUIDITY_WINDOW_YEARS` lives in the intake layer for that reason.
This is what phase 1 warned against doing automatically, honoured: seniority still never
becomes an availability date on its own.

**When the value does not cover what was declared, the LOCK is served first.** A plan moves
with the market while its contributions stand still, so the two sums almost never agree.
So: `locked = min(Σ pending lots, value)`, then `available = min(Σ matured lots, what is
left)`, and the remainder is the undeclared gap phase 1 already names. The order is the
policy, not a detail — serving the available half first leaves a plan with 4.000 € matured,
6.000 € pending and a value sunk to 3.000 € reading as 100 % liquid today, honouring the
letter of the cap while promising exactly the locked money these modules exist not to
promise. And a remainder no lot covers is never available capital: that would be the
illusion #1447 exists to kill, one rung up.

**When the lots exceed the value, the lock fills from the LATEST tranche backwards.** A plan
worth less than its contributions does not say which of them lost the value, so among the
possible readings we take the one that releases the money latest. Same conservative
direction `resolveCapitalAvailability` trims in, and for the same reason.

Two things phase 2 deliberately does NOT change: the engine still reads no clock of its own
(the day arrives from the caller, and without one a holding with lots reads as an undeclared
gap rather than as a lock), and `sideOfTier` remains #1523's decision — a lot says *when*,
never *which column*.

## Amendment (#1687): the ledger may PROPOSE a ladder; the engine still derives none

#1676 made the ten-year window an interface suggestion, filled from inherited seniority
(#1518). That left a gap it did not name: a holding whose own ledger carries dated
contributions knows every date already, and still made its owner type each lot by hand.

So the ficha can now derive a whole ladder from the holding's ledger and offer it. The
line this amendment defends is the one #1676 drew, unchanged: **proposing is not
applying.** The proposal is rendered, the owner confirms or corrects it, and only then is
anything stored. `calculateFireForScope` still reads declared lots and nothing else.

Three decisions inside it:

- **Which rows can date capital, and which cannot.** A real `buy` dates from `executedAt`.
  A `transfer_in` dates from its declared seniority and NEVER from `executedAt` — the
  paperwork day. A `transfer_in` without one, and any row with `source: "opening"` (whose
  date and price the alta fabricated, #1490), date nothing. The ones that cannot are
  **named on screen with their amount**, because a holding that proposes half a ladder
  without saying which half is missing is worse than one that proposes nothing.
- **Exits do not subtract from any tranche.** A `sell` or `transfer_out` shrinks the plan,
  but the ledger does not say which contribution it came out of, and splitting it FIFO
  would invent descuadres — the cost here is average, never FIFO, and this split is about
  liquidity. The cap to the holding's value does the trimming instead.
- **The proposed amount is what was CONTRIBUTED, not what it is worth today.** A pension
  plan is unit-based, so the return attributable to each contribution is exactly
  derivable — but a lot storing today's value of those units would expire daily, which is
  the #1415 failure ADR 0074 forbids. Contributions do not move. The consequence is stated
  on screen: the return earned since is left undated, so the proposal is a **floor** on
  what is redeemable, never the figure the gestora holds.

What this does NOT settle is whether the ten-year rule attaches to the nominal contributed
or to the consolidated right it grew into. The floor above is correct under either reading,
which is why it ships before that question is answered; resolving it can only raise the
proposal, never invalidate a lot already declared.

## Status

Accepted (#1528); amended and extended by #1676 and #1687.
