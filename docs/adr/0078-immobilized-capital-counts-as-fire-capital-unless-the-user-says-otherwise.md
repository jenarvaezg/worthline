# Immobilized capital counts as FIRE capital unless the user declares it does not

## Context

A safe-withdrawal rate assumes a portfolio you sell down and rebalance. A flat in
Plasencia is not that, and #1447 said so on screen: the eligible pool is printed split
into a **sellable** side (cash + market + term-locked) and an **immobilized** one
(illiquid + housing), with each side's debt netted inside it.

But #1447 only *showed* the two natures. Both still counted, so the headline figure
kept promising capital the user may have no intention of ever converting. Measured on
the real portfolio the prototype ran on (18/08, blueprint in #1426):

| Eligible capital        | FIRE age | Funded  |
| ----------------------- | -------- | ------- |
| Everything (as shipped) | 49       | 17,9 %  |
| Sellable only           | 55       | 4,6 %   |

Six years and a factor of four. Which of the two rows is honest is not something the
engine can know: it depends on whether this person plans to sell the brick. That is a
fact about the user, and the app already has a doctrine for those (ADR 0074).

Note what the naive implementation of "leave the brick out" gets wrong. The expected
return is a weighting over the eligible pool, and for a landlord the housing rung is
what drags it down (Jorge: 68,7 % of brick at 3 % against 26,6 % of market at 5 %).
Removing the brick lowers the capital **and raises the rate** — two effects in opposite
directions. An implementation that dropped the capital and kept the old rate would
produce a result *more* pessimistic than what the user declared, and would quote a rate
nobody's money holds.

## Decision

**Whether immobilized capital counts as FIRE capital is a declaration on the scope's
FIRE config, defaulting to "it counts". When it does not, the immobilized rungs leave
the eligible pool AND the weighting the expected return comes from — through the same
predicate — and the immobilized side stays on screen, attenuated, as capital that is
outside the calculation.**

1. **A declaration with a non-expiring form and a null migration.**
   `FireScopeConfig.immobilizedCountsAsFireCapital` is read through
   `fireCountsImmobilizedCapital`, where `undefined` resolves to `true` — the behaviour
   every stored config had before the field existed, so no workspace's figures moved
   when it appeared. It is edited as a checkbox in «Tus supuestos» (#1450), saved and
   read with the rest of the config, and nothing derives or overwrites it (ADR 0074).

2. **One predicate for both halves.** `fireDrawsFromTier(tier, countsImmobilized)`
   decides what the pool contributes *and* what the rate is weighted over, and a rented
   flat's own `rent-derived real return` (ADR 0076) rides its rung: out of the pool, out
   of the rate. Two predicates would be two chances to drop a rung's capital while
   keeping its weight.

3. **The figure FIRE measures comes from the split.** `splitFireCapital` gained
   `drawableMinor` — both sides when the brick counts, the sellable one alone when it
   does not — and it is what `calculateFireForScope` feeds into the FIRE math. The goal
   reservation is clamped there too, against the drawable pool, so a reservation larger
   than the sellable side cannot start eating a side that is no longer in the figure.
   The rows printed under the eligible total and the total itself are therefore the same
   arithmetic, not two readings of it (ADR 0077).

4. **What leaves the calculation is still on the page.** The immobilized row keeps its
   figure and gains «fuera del cálculo» in muted ink: hiding it would make the user's
   capital look smaller than it is, and printing it plain would make the total above
   look wrong. The «solo con lo vendible estarías al X %» footnote from #1447 is *not*
   printed in this mode — that percentage has become the headline, and printing both
   would invent a second measure of one thing.

5. **A withheld rent says so.** A declared net rent on a rung FIRE no longer draws from
   is reported as a notice (`immobilized_not_counted`), never as applied — #1448's guard
   is that a rate is never advertised as taken into account when it was not, and the
   mirror of it is that a user's declaration is never dropped in silence. The copy for
   this one asks the user to fix nothing: it is the consequence of what they declared.

6. **A manual `expectedRealReturn` is untouched.** The declaration moves capital and
   the weighting; a rate the user fixed by hand stays fixed.

## Alternatives considered

- **Let rental income enter as income instead (rejected, #1414).** The opposite move,
  and the one that was already closed: it makes the brick count in a *second* way. This
  ADR is the compatible one — the user declares that it does not count at all. What
  a rented flat contributes to the *rate* remains ADR 0076's business.
- **Make "sellable only" the default (rejected).** It would move every existing user's
  FIRE date on a deploy, in the pessimistic direction, over a fact about them the app
  never asked.
- **A third liquidity rung / a per-asset "counts for FIRE" flag (rejected).** The
  per-asset exclusion already exists (`excludedAssetIds`) for "this specific thing is
  not part of my plan". This declaration is about a *nature* of capital, so it belongs
  where the natures already are — the split — and stays one checkbox instead of a
  checklist the user must maintain as assets are added.
- **Previewing the checkbox live like the four scalar assumptions (rejected for now).**
  `previewFireWithAssumptions` (#1450) deliberately keeps the server's pool and rate:
  it recomputes what the assumptions move, and this declaration moves the pool itself.
  It is saved to be seen, like the per-tier rates and the manual return beside it, and
  the field says so.

## Consequences

- `FireCapitalSplit` is no longer presentation-only: `drawableMinor` is an input to the
  FIRE figure. `sellable.amountMinor + immobilized.amountMinor` is still the whole pool
  net of debt and reservation; what changed is that it is not always what FIRE measures.
- `context.eligibleGrossMinor` is gross of *reservation* over the drawable pool, so
  `goalFireDelay` cannot probe against capital the FIRE number never counted.
- An underwater mortgage still spills across sides: debt whose collateral does not cover
  it is owed out of whatever else the scope holds, declared out or not.
- `get_fire_context` and the agent view report the config verbatim, so an assistant that
  quotes a FIRE number for a scope with the declaration off is quoting the sellable-only
  measure — the same one the screen shows.
- #1428's «gasto sostenible» is defined over the sellable side; with this declaration
  off, that view and the FIRE headline finally tell the same story.
