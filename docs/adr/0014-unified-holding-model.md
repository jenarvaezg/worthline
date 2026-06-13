# Holdings are unified; "kind" is decomposed into attributes

The app split holdings across an `assets`/`liabilities` table divide and a four-value
`AssetType` (cash, manual, real_estate, investment), and promoted investments to their own
top-level "Inversiones" section. That "kind" axis was carved at the wrong joint: the
net-worth math reads only the **liquidity tier**, never the asset type (the sole place type
matters is one derived-value branch); `cash` and `manual` were behaviourally identical; and
"investment" reduced to "the value is derived". We decompose "kind" into independent
attributes a **holding** carries — its **instrument** (what it is: a label that defaults the
rest), its **valuation method** (how its value/balance evolves: stored / derived /
appreciating / amortized / anchored), its **liquidity tier**, and its direction (owned vs
owed). "Investment" is the **derived** valuation method, not a kind, so **Inversiones stops
being a navigation section**: there is one unified Patrimonio list with a single
instrument-first "Add", and a holding's method-specific surface (operations, appraisals,
amortization plan) lives on its detail page.

## Considered options

- **Keep Inversiones as a dedicated workbench, just stop double-listing** — rejected: it
  still contradicts the glossary's "Patrimonio = the unified list of a scope's holdings",
  and the only justification (richer editing) is met by a method-specific detail page, not
  a separate top-level section.

## Consequences

- The derived-value invariant of **ADR 0006** stands (an investment's value is still always
  derived, never typed); this decision overturns only its *navigational* consequence — "no
  inline value edit" no longer implies "a separate section".
- Charts and groupings become lenses over the one unified list (by direction, by rung, by
  instrument) — presentation, not model.
- `cash`/`manual` as separate types, and the implemented-but-unreachable CoinGecko provider,
  are resolved by construction: crypto becomes an instrument whose default price provider is
  CoinGecko.
