# Housing returns as a liquidity-ladder rung

ADR 0013 recut the ladder to four pure-accessibility rungs and demoted housing to an
instrument-derived grouping, on the principle that a rung answers only "how quickly and
cheaply does this convert to cash?". In practice the dashboard renders three surfaces over
that axis — the **Evolución** composition chart, the **Liquidez** breakdown (donut + rung
rows), and the **drilldown** — and they disagreed: Evolución and the drilldown carved
property out of the illiquid rung _by holding id_ into a separate "Vivienda" band/group,
while the Liquidez breakdown left the home inside the illiquid rung. So the same home
counted inside "Ilíquido" on one surface and as its own band on another, and clicking the
Ilíquido donut slice drilled into a group that silently dropped the home. We promote
**housing** to a fifth liquidity-ladder rung (most to least accessible: cash, market,
term-locked, illiquid, **housing**). `tierOfAsset` returns `housing` for every property
instrument and a housing-secured liability inherits it (netting the mortgage against the
home on the housing rung); all three surfaces bucket by the rung and the by-id carve is
deleted. The ladder is no longer "pure accessibility" — housing is the one recognised
carve-out households reason about separately from other illiquid assets.

## Considered options

- **A presentation lens that splits the illiquid slice in the breakdown only** — rejected:
  it leaves three code paths defining "what is housing" (the two by-id carves plus the
  lens) and keeps the model and the screens out of step; the rung is where the other two
  surfaces already agree.
- **A derived display bucket shared by all surfaces, model untouched (`LiquidityTier`
  stays four)** — rejected: it produces the same pixels with no migration and honours 0013,
  but keeps "housing" as a second, parallel classification the type system cannot enforce;
  we preferred one axis the compiler checks exhaustively over two correlated ones.
- **Leave the model and fix only the drill mapping** — rejected: the Ilíquido slice would
  still mix the home with gold and collectibles, which is the confusion that was reported.

## Consequences

- `LiquidityTier` gains a fifth member; every exhaustive switch and `Record<LiquidityTier,
…>` must handle `housing` (the compiler enumerates them). Order is most→least accessible,
  housing last; `isLiquid` is unchanged, so **liquid net worth and ADR 0003 are untouched**.
- A housing-secured liability moves from the illiquid rung to the housing rung, still
  netting against the home (ADR 0013's netting rule, new rung). The housing rung's net
  equals **housing equity**; the donut arc stays gross, the mortgage shows on expanding.
- Snapshots freeze the rung (ADR 0008); the vocabulary changes, so historical
  `snapshot_holdings` rows are migrated `illiquid → housing WHERE counts_as_housing` — the
  mirror of the recut migration that ran `housing → illiquid`. The migration only relabels
  the bucket; no value and no frozen flag change, so no headline figure moves.
- **Housing equity** stays derived from the frozen `counts_as_housing` / `secures_housing`
  flags, not the rung, and **FIRE** eligibility stays keyed on the primary-residence flag.
  A rental property therefore sits on the housing rung yet remains FIRE-eligible — the rung
  and these two figures stay decoupled, preserving 0013's fix for the "three non-coincident
  definitions" of housing.
- The `housingHoldingIds` carve in the composition chart and the drilldown is removed:
  housing is a native band/group, `rest` is term-locked + illiquid with no exception, and
  the housing drilldown selects by rung.
- This supersedes the **housing** half of ADR 0013; its four-pure-rungs rationale still
  stands for retirement, which remains folded into **term-locked**.
