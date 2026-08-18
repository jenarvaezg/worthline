# The measured savings is the declaration's only witness, and an achievement badge answers to it

## Context

ADR 0074 cut the plan→FIRE derivation: the declared savings capacity is now the only
contribution the projection assumes. That is the right input — but it leaves the
figure with **no check at all**. Jorge's 1.500 €/mes was never verified against
anything before the cut, and after it the app stops even accidentally noticing.

Of the three figures describing the same monthly flow, only one can be produced
without anybody typing it:

```
ahorro = rentas netas + pensión y otros ingresos − gasto
```

In his workspace the identity does not close: rents 1.957,27 € − spending 2.000 € =
**−42,73 €/mes**, while his operations measure **+119 / +60 / +150 / +150 €**. Either
the rents are declared gross or the spending is incomplete — and neither is visible
until the measured figure is **crossed** against the declared ones. The inverse case
is the dangerous one: somebody declaring 1.500 €/mes while his ledger says he is
decapitalising, with a green "Coast FIRE alcanzado" on screen telling him he is on
track.

An achievement badge is a claim about the *future* made from a snapshot of the
*present*: percent funded and coast both project forward on the declared scalar. A
flat rented out for 1.000 €/month does not bring someone who dis-saves 100 €/month
closer to FIRE — it takes him further away, and today's screen cannot know that
because it projects on what he typed.

## Decision

**The measured savings — net money into investments, from the operations ledger — is
the declaration's witness: it is crossed against the declared capacity as a
data-quality signal, and it vetoes achievement badges while it is negative. It never
becomes an input** (ADR 0074 stands).

1. **One definition of savings, two questions.** `netInvestedMinor` (a buy is cost out
   of pocket, a sell is money pulled back) is the single money rule in
   `monthly-savings.ts`. `suggestMonthlySavingsCapacity` asks "what default should the
   form offer?" and floors at 0; `measureMonthlySavings` asks "what does the ledger
   show?" and **keeps the sign** — the negative is precisely the fact the veto needs.
   Never two implementations of what savings are.

2. **The measurement divides by time elapsed, not by time between operations.** A
   single 1.000 € buy six months ago is 1.000 € spread over six months of living, not
   a 1.000 €/mes habit. The window is the trailing **12 calendar months**, clipped to
   how long the ledger has existed inside it (a two-month-old ledger divides by 2, so a
   beginner is not read as saving a sixth of what he saves). Twelve months absorbs
   extra paychecks and one-off levies while still reacting to a real change of habit
   within a year.

3. **Evidence, or silence.** Under **3 months** of ledger there is no measurement worth
   trusting — that is a payday and a holiday, not a habit — and a window that mixes
   currencies is not a measurement either, because part of the money is missing from it
   (ADR 0072/#1401). Both cases are silent: no alert, and **no veto**. A ledger that
   predates the window with nothing inside it measures **0 saved**, which is an honest
   reading of a year without a contribution — only an empty ledger is "no data".

4. **A gap must clear both thresholds to be news:** 100 €/mes absolute **and** a
   quarter of the larger of the two figures. The floor keeps rounding and a skipped
   month quiet; the ratio keeps a 100 € wobble on a 2.000 €/mes declaration quiet.
   Jorge's real case clears both by an order of magnitude.

5. **The signal states the disagreement and assigns no blame.** All three figures on
   show (declared, measured, gap). An optimistic declaration, stale spending, rents
   declared gross, and savings that never reach an investment produce the same shape,
   and only the user knows which it is. One sentence
   (`describeSavingsDivergence`) is shared by the health inventory and the FIRE panel,
   so the wording cannot drift between where the doubt is raised and where the figures
   it doubts are drawn.

6. **A vetoed badge is attenuated, not removed.** The capital really is there on paper,
   so it still says so — in the aviso register, worded "alcanzado **sobre el papel**",
   with the measured figure named underneath. Hiding it would leave a user with no
   explanation for a badge that vanished; drawing it green would tell him a falsehood
   about where he is heading. `fireAchievement` is the one door both screens that draw
   a badge read, so the veto cannot be enforced on the home and forgotten on
   /objetivos.

7. **The alert is not on the hero.** The home hero renders only while signals bear on
   confidence in **today's** figure (#665). This one concerns the projection, exactly as
   `MISSING_FIRE_CONFIG` does, so its human surface is the FIRE panel on /objetivos —
   beside the FIRE date and the funded percentage it actually puts in doubt — and the
   agent view keeps it in the shared inventory.

## Alternatives considered

- **Compare against the full declared identity (spending − rents) instead of the
  declared capacity (rejected for v1).** The app has no declared rents field: rental
  income lives in payouts, and reading it as a monthly declaration is #1414/#1448's
  subject. Declared-vs-measured savings is the one pair both sides of which exist
  today.
- **Measure over the whole history, as the form's suggestion does (rejected).** A
  ledger that stopped three years ago would keep vouching for a declaration made
  today, and one lump sum reads as a monthly habit (the very shape ADR 0074 §5
  refused to seed from).
- **Hide the badge outright (rejected).** See §6: an unexplained disappearance is worse
  than a caveat, and the badge's own words carry the caveat.
- **Make the signal overrideable (deferred).** Somebody who saves in a current account
  and never invests will see this gap permanently and cannot acknowledge it away. The
  override vocabulary is per-holding (`{code, entityId}` with a ficha to acknowledge
  from) and a scope has no such surface, so the door is left for when the case is
  reported rather than invented now.
- **Veto on a flat zero too (rejected).** Idle is not dis-saving. Somebody at 100 %
  funded who stopped contributing has genuinely arrived; the veto is for a trajectory
  that goes *down*.

## Consequences

- `measureMonthlySavings`, `assessSavingsCoherence`/`scopeSavingsCoherence`,
  `describeSavingsDivergence` and `fireAchievement` are the new domain seams;
  `suggestMonthlySavingsCapacity` keeps its signature and its behaviour, now built on
  the shared money rule.
- The health engine gains a required input (the operations ledger, already in memory in
  both consumers) and a `savings_coherence` category, mirrored in the agent-view
  contract, its query enum and the assistant's tool schema.
- `FireGlance` loses `isFunded` / `isAlreadyAtCoastFire` in favour of one
  `achievement`, so a screen cannot branch on the raw pair and skip the veto.
  `prepareDashboardState` takes the ledger as an optional input: absent, the badge
  behaves exactly as before, and the two page loads that draw it already hold the map.
- The scope→holdings filter used by the health engine is now shared
  (`scopeOwnedHoldingIds`), so the alert and the veto can never measure different sets
  of holdings for the same scope.
- Not covered: whether the agent view's FIRE context should carry the veto (it reports
  `isAlreadyAtCoastFire` raw today — an agent could still congratulate), and the
  rents/spending half of the identity (#1414, #1448).
