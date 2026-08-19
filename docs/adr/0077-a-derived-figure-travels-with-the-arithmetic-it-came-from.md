# A derived figure travels with the arithmetic it came from

## Context

Jorge's FIRE figures were verified to the cent (#1414) and he still did not believe
them. His diagnosis was not about the maths:

> Worthline no debería presentar `NÚMERO FIRE → 685.714 €` como si fuera una constante
> física.

`685.714,29 €` is `2.000 €/mes × 12 ÷ 3,5 %`. Both inputs are his, both are editable,
and neither appeared anywhere near the result. The same held for the rest of the panel:
a lone «68,5 %» with no noun (a big percentage with no noun reads as a probability of
arriving), three scenario cards saying 8 / 11 / 18 años with nothing explaining why, a
dashed line on the chart that could have been anything, and a footer stating «Retorno
real estimado: 3,5 %» — a weighted average of four rungs, printed as a scalar with its
weights thrown away. Read with the weights, that 3,5 % says something the scalar only
insinuates: his expected return is governed by the flat, not by the stock market.

The repo already had the rule. `get_calculation_trace` and `explain_figure` exist in the
MCP surface, and ADR 0054 fixed *attribution never becomes a figure* for payouts. The
/objetivos screen was simply the surface that never got it.

The engineering trap is the obvious implementation: compute the explanation next to the
figure. Two computations of the same arithmetic drift — one gets a fix, the other keeps
the old rounding, and then the app is arguing with itself in public.

## Decision

**A figure the app derives is shown with the inputs it was derived from, and the
explanation is produced by the same computation as the figure — never by a second one.**

1. **The engine returns the breakdown, not just the scalar.** `fireReturnMix` computes
   the weighted real return AND the slices it is made of (one row per rung, plus one per
   holding whose own rate substitutes its rung's under ADR 0076). `effectiveRealReturn`
   is now literally `fireReturnMix(...).rate`, and `ScopeFireResult.returnMix` carries
   the rows. There is no path by which the table under the chart and the rate above it
   can disagree, because there is only one arithmetic.

2. **Provenance rides with the value it explains.** `scopeAgeSource` returns the
   derived age together with the birth date and the member it binds on, and
   `scopeCurrentAge` is that function's `.age` (ADR 0073's rule, now sayable: «tu edad
   sale de tu año de nacimiento (1963)»). Same shape as point 1: the explanation is a
   projection of the computation, never a re-derivation beside it.

3. **The screen prints the inputs, not a link to them.** The FIRE number carries
   `gasto anual ÷ tasa de retirada = número`, with both inputs linking to where they are
   edited. The funded percentage carries its noun and its fraction
   («68,5 % financiado — 469.671 € de 685.714 €»), and so does progress toward Coast,
   whose requirement now says what it was discounted from and over how many years. The
   chart's dashed line is labelled with the target it marks, and each bar carries its
   year and its figure.

   The rule binds the *engine*, not the component: what a level funds per year
   (`FireLevel.fundsAnnualMinor`) and the multiple of spending it stands for
   (`spendingMultiplier`) are emitted by `fireLevels`, because computing them on screen
   means inverting the division that produced the amount — and keeping a second copy of
   the 0,7 / 1,5 defaults. `coast` carries neither: it is defined by the FIRE number and
   the years left, not by a multiple of spending, so «financia X €/año» would invite
   withdrawing from the capital that exists precisely to be left alone.

4. **Inputs are explained in the open; results are explained in a fold.** The
   projection's assumptions (spending, withdrawal rate, contribution, the three
   scenario rates read off the scenarios that actually ran, the ages, and the weighting
   table) live in one native `<details>` under the chart — the same disclosure register
   the panel already used for «¿Qué cuenta como activo elegible?». Prototyping the
   alternative (glosses visible everywhere) produced a brochure, confirmed with the
   user.

5. **An explanation that does not describe the figure in use is not shown.** With a
   manual `expectedRealReturn` the weighting table is hidden and the row says the rate
   was fixed by hand: a table explaining a number the projection ignored is worse than
   no table. Same rule as ADR 0076's withheld-rent note.

## Consequences

- The scope of "auditable" here is the FIRE number, the three levels, the funded
  percentage and the projection's ETAs. The full chart series is deliberately out: a
  hover figure per bar, not a trace per point.
- The effective-rate line in the panel's foot is gone. It printed the same rate the
  assumptions fold now prints WITH its weights, and two places printing one derived
  figure is exactly what point 1 forbids. ADR 0042's «/objetivos footer: shows "Retorno
  real estimado de tu cartera: X %"» and ADR 0076's note about that same foot line are
  superseded **on location only** — the rate is still shown, now with its weights, and
  the rules those ADRs state are unchanged.
- `fireReturnMix` normalizes by the weight actually used, keeping
  `effectiveRealReturn`'s behaviour byte for byte: an empty pool still falls back to the
  market default, and now returns no rows, since a rate with no weight behind it has no
  provenance to print.
- The weighting table names holdings. That is user-authored text inside a figure's
  explanation, which is fine on a screen the user owns; it is one more reason the mix is
  presentation-only and never an input to any total.
- The panel moved to its own module (`fire-panel.tsx`) with the wording in pure view
  modules beside it (`fire-assumptions-view`, `fire-funding-view`). That is the skeleton
  the rest of the screen pass lands in (#1450 moves the config in, #1425 splits Coast).
- Not covered here: exposing the same breakdown through `explain_figure` /
  `get_calculation_trace` so an agent quotes the weights the screen shows, and whether
  the other derived surfaces (delta breakdown, returns) owe the same treatment.
