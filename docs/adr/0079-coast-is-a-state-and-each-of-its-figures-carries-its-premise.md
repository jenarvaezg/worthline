# Coast is a state, and each of its figures carries its own premise

## Context

Jorge, looking at his /objetivos screen: *«hay algo ahí que no está bien»*. He was
pointing at two KPIs side by side (#1425):

```
Coast requerido   577.262 €        ALCANZAS FIRE EN 11 años · a los 73 años
Edad Coast        73,0
```

His reading was that if the Coast age equals the FIRE age, Coast means nothing. He was
right that something was wrong, and wrong about what. The word «Coast» was doing three
different jobs on one screen:

1. **`coastFireAge` answered a question its name did not ask.** It was
   `currentAge + log(fireNumber / eligible) / log(1 + rate)` — the age today's capital
   reaches the **full FIRE number** at **if contributions stop right now**. A true and
   useful figure. But `coastFireRequired` next to it is computed against the *target
   retirement age*, so the screen asserted both «you need 577.262 € today to coast to
   FIRE **at 67**» and «coasting from today you arrive **at 73**». Two answers to two
   questions, sharing a prefix, reading as one family — which invites exactly the
   conclusion that the arithmetic is broken, when it is not.

2. **The age Coast is *actually* reached at was computed nowhere.** The progress bar has
   drawn a tick at Coast since PRD #507, which asserts a point on the road, which
   asserts a date. No module projected the trajectory **with** contributions until it
   crossed `coastFireRequired`. The only figure available assumed contributions of zero.

3. **Coast rode the «Niveles FIRE» rail as a card beside Lean/Regular/Fat** — and then
   needed a paragraph underneath explaining that this card did not mean what the others
   mean. That paragraph was the confession. Lean/Regular/Fat answer «what standard of
   living do I want to fund?» (a spending target); Coast answers «where am I in
   funding it?» (a state). Barista is a third case that *does* belong on the rail: a
   part-time income shrinks the deficit the capital must cover, so it is a spending
   target with less to fund.

Why the two ages coincided for him is a separate matter, already fixed: his projection
ran on 100 €/month of phantom plan-derived savings (#1416) and a frozen age (#1415).
With his real 1.500 €/month the two figures separate to ~74 and ~68 on their own. As
contributions tend to zero the Coast date tends to the FIRE date, and that is *correct*
— coast only buys slack if you save. The screen was accidentally telling him his
savings plan is irrelevant to his outcome.

## Decision

**Coast is a state of funding, so it lives beside the progress bar whose tick draws it
and never on the levels rail. Each of its figures names the premise it rests on: the age
projected WITH the declared savings is «llegas a Coast», the zero-contribution age is
«si dejas de aportar hoy», and having arrived is a badge, not an age.**

1. **`fireCoastArrival(context)` dates the arrival, reusing the existing doors.**
   `calculateFire` for the requirement — so the boundary between «already there» and
   «X years away» is the same figure the screen prints above — and
   `projectFireFromContext` + `fractionalFireYear` for the trajectory, the same one that
   dates the levels and the goal delays. It projects **against the coast requirement
   itself**, not the FIRE number: then `yearsToFire` *is* the crossing year, and a FIRE
   that never arrives inside the horizon cannot erase a Coast arrival that does. Three
   outcomes, no fourth: `reached`, `eta`, `unreachable`.

2. **`coastFireAge` is renamed `fireAgeIfContributionsStop`.** The premise is the whole
   figure, so it is in the name — in the domain type, in the agent-view contract, and in
   the label on screen («Si dejas de aportar hoy → FIRE a los 74»). The figure itself is
   unchanged and is *kept*: «what if I stop saving?» is honest and cheap to answer.

3. **`"coast"` leaves `FireLevelKey`.** With it goes the paragraph that existed to
   disown it, and the rail becomes one axis. Nothing serialized carried the key — the
   rail is computed per render — so the union change is the whole migration.

4. **Ages print in whole years, under one convention.** A decimal on an age projected a
   decade out fakes a precision that does not exist: 72,99 printed as «73,0» is what made
   a correct calculation look broken. The arrival age is the scenario's own `ageAtFire`
   — the projection year in which the crossing happens — the same convention as the FIRE
   age printed beside it, because two ETAs off one trajectory under two rounding rules is
   what ADR 0077 exists to prevent. The fractional interpolation stays, in the gloss.

5. **No Coast without compounding room, and the hole says why.** `calculateFire` emits
   the coast block only when `growthFactor > 1` — a positive real return AND a target age
   still ahead. Below that the «requirement» comes out at or above the FIRE number, and
   the sentence beside it («reach this and compound interest does the rest») is false:
   there is no rest to do. Dating the figure made the incoherence literal — at a default
   `targetRetirementAge` of 65, anyone past 65 would have read «you reach Coast three
   years AFTER you reach FIRE». One door suppresses the requirement, the badge and the
   arrival together, so the bar's tick, the panel, the agent view and the achievement
   cannot disagree about whether Coast exists; and because a figure that vanishes in
   silence reads as a bug, the panel prints the reason — a rate that does not compound
   and a target age already reached are different sentences, because what the user would
   change is different.

6. **Already at Coast is a seal.** `isAlreadyAtCoastFire` already feeds the achievement
   badge (ADR 0075), so the arrival row says «alcanzado» and stops inventing an age;
   the badge above it is the mark, veto included.

7. **The live preview recomputes it.** The assumptions island (#1450) calls
   `fireCoastArrival` on the previewed context, so raising the declared savings pulls
   the Coast date in while the user types — which is the one interaction that makes the
   concept legible.

## Alternatives considered

- **Just rename the label (rejected).** It was the first suspicion and it fixes only
  defect 1. The figure the user actually wanted to read — when he reaches Coast — still
  would not exist.
- **A closed-form solution for the arrival age (rejected).** With a non-zero
  contribution stream there is no clean closed form, and a second formula beside the
  trajectory is a second chance to disagree with the chart above it (ADR 0077).
- **Projecting to the FIRE number and interpolating Coast on that trajectory
  (rejected).** It is what `fireLevels` does for its own rail, and it inherits
  `fractionalFireYear`'s precondition: a target never reached inside the horizon returns
  `null` for *every* level below it. Coast is precisely the case where the low target is
  reachable and the high one may not be.
- **Dropping the zero-contribution age entirely (rejected).** It answers a question
  users ask. It only ever needed its premise in front of it.
- **Keeping Coast on the rail with better copy (rejected).** The copy was already there
  and was already an admission. Two axes on one rail is the defect; wording is not.

## Consequences

- A scope with a zero-or-negative expected return, or already at its target age, loses
  its coast requirement, its coast tick and its «Coast FIRE alcanzado» badge — figures it
  should never have had. The panel states the reason in their place.
- `FireLevel.fundsAnnualMinor` is required now that every level on the rail is a spending
  target.
- `FireResult.coastFireAge` no longer exists; readers use
  `fireAgeIfContributionsStop`, and `get_fire_context` reports both it and the new
  `coastArrival` so an assistant cannot repeat the confusion the screen made.
- The levels rail is Lean · Barista · Regular · Fat. Any consumer counting on four
  cards, or on Coast being `levels[0]`, sees three (four with Barista).
- `/objetivos` renders one more projection per load (a 60-step loop over the same
  context) — the same cost the rail already pays.
- #1428's «gasto sostenible» layer can lean on `fireCoastArrival`'s three states: its
  own headline needs the same `unreachable` case.
