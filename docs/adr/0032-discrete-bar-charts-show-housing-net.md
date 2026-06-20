# The net-worth chart and its drilldowns are discrete stacked bars showing housing net

ADR 0009 made the dashboard's history a single server-rendered SVG **composition
chart**: gross asset bands stacked above zero as filled **areas**, the aggregated
debt as an area below, and a net-worth line over the total, with the home shown
**gross** (the property's full value) and its mortgage carried in the negative
debt stack. In practice that picture read poorly. Housing dominates a typical
balance sheet (gross home ≈ 90 % of gross assets here), so the gross-home area
plus its mortgage area swamped everything else into invisible slivers — two solid
blocks. The filled areas, joined by straight segments between sparse monthly
closes, looked heavy and polygonal; and the per-holding drilldown sparklines
(lines) degenerated into lonely vertical ticks for the many holdings with only
1–3 captured points.

This ADR keeps everything ADR 0009 settled (one chart, server-rendered SVG, URL
state, zero client JS for the drawing) and changes only the **visual grammar**:

1. **Discrete stacked bars, not areas.** Every period is its own column; bands
   stack as rectangles from the zero baseline, debts hang below, the net-worth
   line and close markers ride on top. The existing month → quarter → year
   bucketing (`granularityForSpanMonths`) keeps long ranges legible, so the bar
   count stays bounded. Bars state each monthly close as an independent measured
   fact and never interpolate between captures.
2. **Housing shown net by default.** The Vivienda band is **equity** (property
   value − the debt that secures it, the `securesHousing` carve of ADR 0013), and
   that securing mortgage is folded out of the negative debt stack instead of
   shown separately. The "Ocultar vivienda" control becomes **URL state**
   (`?vivienda=oculta`) so it survives range/Vista navigation. A `gross` mode is
   retained in the geometry but is not the default UI.
3. **The drilldown is a zoom of the same grammar.** The group aggregate and each
   per-holding sparkline are bars too (with a minimum bar height so a 1–2 point
   holding renders as clean discrete ticks, never a sliver). Holdings no longer
   in the portfolio are dropped from the cards entirely (their past value still
   lives in the aggregate history); each card gets a real bordered surface.

The **reconciliation invariant (ADR 0008) is preserved exactly**: the net-worth
line is computed from raw band values minus raw shown debts, so folding the
mortgage into the equity band is a pure presentation rearrangement — the line is
byte-identical between `gross` and `net`, asserted by test.

## Considered options

- **Discrete stacked bars + housing-net + drill-as-zoom** (chosen) — bars match
  genuinely discrete monthly-close data and stay honest at any sparsity; net
  housing collapses the dominant gross-home block into a balanced equity band and
  removes the mortgage double-image; one bar grammar end-to-end means drilling in
  is a literal zoom with no second mental model to learn. Cost: a geometry rewrite
  (area polygons → per-period rects) across the chart, the shared stacked engine,
  and the drilldown, plus updated tests; and on very wide ranges bars can read
  denser than a smooth area (mitigated by the existing quarter/year bucketing and
  the net line on top). An independent four-lens design panel (data-viz, design
  system, end-user, minimalism/robustness) picked this 3–1 with the dissent
  agreeing the main chart should be bars.
- **Keep areas, just show housing net** — rejected: net housing fixes the
  dominance but the filled areas stay heavy and polygonal on sparse monthly data,
  and area sparklines fabricate a slope from a 2-point holding. It fixes one of
  the three complaints.
- **"Form encodes meaning": bars for the composition, area for single series**
  (area aggregate + area sparklines) — rejected: the bars→area shift inside one
  flow reads as two grammars bolted together, and a 2-point area sparkline still
  invents a trend. The breadcrumb already signals the composition→single-series
  transition, so the second grammar buys little.
- **Everything area (revert to a softer all-area look)** — rejected: stacked
  areas smear band boundaries into a gradient (only the bottom band sits on a
  common baseline) and hide the housing-purchase step; the panel rejected it
  unanimously for the main chart.

## Consequences

- The hero is also re-treated (light green-tinted card, no longer the single dark
  panel) so the dashboard reads as one family — a design-system change documented
  in `docs/design-system.md` §3, not a separate ADR.
- `buildCompositionChartGeometry` and the shared stacked engine now emit
  `bars: {x,y,width,height}[]` per band instead of `areaPoints`; the drilldown
  sparkline emits bars with a min-height floor; `DrillHoldingMultiple` loses the
  `noLongerHeld`/nullable-value machinery. Consumers and tests updated.
- The `--ink-panel*` and `--*-on-dark` tokens fall out of use (the hero no longer
  has a dark surface); kept defined for a possible dark mode.
- ADR 0009 stands for the chart's architecture (server-rendered SVG, URL state,
  zero client JS); this ADR only changes its visual grammar and the housing
  framing. ADRs 0008 (reconciliation), 0013 (`securesHousing` carve) and 0022
  (housing rung) are unchanged.
