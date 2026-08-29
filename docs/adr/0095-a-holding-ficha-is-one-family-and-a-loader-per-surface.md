# A holding ficha is one family and a loader per surface

## Context

`/patrimonio/[id]/editar` is the one screen that edits any holding worthline knows:
a fund with an operations ledger, a mortgage with an amortization plan, a flat with
market appraisals, a mirrored Numista collection, a Binance rung, a current account
whose value is simply what somebody typed.

ADR 0014 already settled how that fan-out is decided — the holding's **valuation
method** — and #152 split the sections themselves into `_surfaces/`, one component
per surface. What was never split was the **orchestrator**. The page had grown to
966 lines, and it worked like this:

- It ran every family's reads in one preamble, each behind its own inline guard:
  the housing anchors behind `isAppreciating`, the amortization plan behind
  `debtModel === "amortizable"`, the operations ledger behind `isDerived`, the
  Numista source behind `isCoinCollection`, the Binance back-link behind
  `asset?.instrument === "crypto"`.
- It derived about a dozen instrument booleans (`isDerived`, `isCoinCollection`,
  `isBinanceHolding`, `isMarketInvestment`, `hasManualLedger`, `isBackfillCandidate`,
  `isSnapshotCorrectionEligible`…) — and then **re-spelled the same conditions** at
  each section: `asset && method === "derived" && !isCoinCollection &&
  !isBinanceHolding` appears four times in the render, once per surface that wanted
  it.
- It bound fourteen server actions to the holding id, for surfaces most fichas
  never render.

Two costs followed. The first is drift: a condition written five times is a
condition that can be wrong in one of them, and nothing in the types would say so.
The second is that adding a surface meant editing the preamble, the boolean block
and the render — the page changed for every reason any holding could have.

## Decision

**A ficha is a resolution, a family, and a loader per family. The page orchestrates;
it does not branch on the instrument.**

1. **The family is decided once, in a pure module.** `holdingFamily` (`_families/
   holding-family.ts`) maps a holding to one of six families — `investment`,
   `housing`, `debt`, `coin-collection`, `binance`, `stored` — and is the only place
   that decision is made. It is pure and tested. The **instrument wins over the
   method** for the two connected-source families: a coin collection and a Binance
   rung are `derived` (ADR 0016/0021) but mirror positions instead of keeping a
   ledger, so a method-first switch would offer them a ledger they have not got.

2. **One dispatch point.** `loadHoldingSurface` (`_families/holding-surface.tsx`) is
   the only `switch` on the family. It makes exactly one read of its own — the
   Binance back-link — because that read *is* the routing question, and only a
   `crypto` asset pays for it.

3. **A family loads only what it paints.** Each loader owns its rows, its sections,
   and the server actions those sections post to. A cash account issues no read at
   all; a mortgage never touches the operations store; an investment never asks for
   a valuation anchor. There is no read "in case some branch needs it".

4. **What the family owes the shared chrome is named, not re-derived.** The surface
   it returns carries `basics` (what «Lo básico» shows for this holding: the
   investment row, the value-only warning, the raw-balance door, whether the
   identity is locked by a source), the `operations` ledger the warning collector
   folds, and what the Papelera would withdraw. The page reads those fields; it does
   not recompute the conditions behind them.

5. **Shared chrome that still loads gets its own module, not a place in the page.**
   `_chrome/` holds the warnings band, the Cobros panel — loaded for every asset and
   **placed by the family**, because only the family knows where in its own order it
   belongs — and the Zona de peligro with its managed-portfolio cash gate (ADR 0085).

6. **A loader carries no guard for a case it cannot be called in.** The context comes
   in two halves: `FichaContext` is everything resolved before the family is known,
   and an `AssetFamilyContext` / `DebtFamilyContext` adds the holding, non-nullable.
   An id that resolves to neither is the dispatch's `null`, which the page turns into
   the 404 it is.

## Consequences

- **Nothing on screen moves.** Same sections, same order, same fields, same actions,
  same URLs. The refactor is pinned by the ficha tests for an investment, a debt and
  a stored holding — which assert both what renders and which store methods are
  **not** called to render it.
- **A holding is now one family, exclusively.** The old page rendered its debt
  surface behind a bare `{liability ? …}`, independent of whether an asset with the
  same id had already claimed the ficha — so an id present in BOTH tables painted
  the asset's surfaces *and* the debt model. Storage ids are disjoint across the two
  tables, so this was unreachable; the dispatch now decides it deliberately (the
  asset wins) instead of leaving it to the order of two guards.
- **Adding a family is a case and a module.** Not a boolean in the page, not a read
  in a shared preamble, and no existing family re-read to make room.
- **The page is 233 lines.** It resolves the public id (#1318), loads the surface,
  renders the chrome, and places the family's body inside the accordion.
- **The cost is one indirection.** Reading "what does a mortgage ficha do?" now means
  opening `debt-family.tsx` instead of scrolling one long file. That is the trade
  ADR 0014 always implied and #152 made for the sections; this extends it to the
  loads.
- **`investment-family.tsx` is still the biggest module**, because the ledger really
  is the richest surface: returns, benchmark, traspaso, statement and two price
  repairs all hang off it. Its action binding lives in `investment-actions.ts`, so a
  new surface's action does not edit the file that renders.
