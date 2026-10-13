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
   identity is locked by a source) and what the Papelera would withdraw. The page
   reads those fields; it does not recompute the conditions behind them. (Until #1850
   it also carried the `operations` ledger the warning collector folded; the family
   now reads its warnings itself and hands them back in `FichaLayout.warnings`.)

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

## Amendment (#1826): a family also says how its ficha is laid out

The investment ficha stopped being one column behind «Configuración avanzada» (#1731,
B2 of #1737): it is a state header with an action bar, one action at a time in a side
panel, and tabs. The decision above holds — the page still does not branch on the
instrument — and gains one field:

- **The surface names its layout.** `HoldingSurface.layout` is either `advanced` (the
  family's `body`, inside the accordion, as before) or `ficha` (a `FichaLayout`: the
  header's figures and value, the actions — each a form for the panel — the family's
  tabs, and which tab or panel each `formId`'s refusal lands on). The page switches on
  the LAYOUT, never on the family, so moving a family to tabs (#1824) is a change to
  that family's loader and nothing else.
- **The behaviour is common, not per family.** `_ficha/holding-ficha.tsx` renders
  header, bar, tabs and panel; `_ficha/ficha-view.ts` is the pure URL contract
  (`?pestaña=`, `?accion=`, the legacy `?abrir=`, refusals that came back in the URL).
  A family states what it carries, not how it behaves.
- **The chrome becomes a tab.** On a tabbed ficha the page appends «Datos del activo»
  — «Lo básico», the availability, the Zona de peligro last — and points those forms'
  terminals at that tab.
- **The shared Cobros panel comes in pieces** (`PayoutsPanel`): the whole section for
  an accordion, its record (a tab) and its entry forms (an action) for a tabbed ficha,
  plus the dated payouts a family that measures a return folds instead of reading them
  twice.
- **The page is no longer 233 lines** — it carries both layouts until every family has
  moved; the accordion branch and `SurfaceLayout.advanced` go with the last one.

## Amendment (#1827–#1830, #1731 review): what a tabbed ficha carries besides its tabs

The slices that finished the investment ficha added fields to `FichaLayout`. The
decision above still holds — the family states WHAT it carries, the common pieces say
how it behaves — and these are the new things it states:

- **`warnings`, `inlineWarnings`, `warningFixes`: a warning is in one place only.**
  The family reads the holding's active warnings ONCE (`holdingWarnings`, the same
  collector the board and the health engine run) and hands the list back; the page
  gives that same list to the band. `inlineWarnings` names the codes the family prints
  beside the figure they are about (the missing price symbol, next to the price), and
  the band leaves out exactly those — so a warning can move from the band to its
  figure but can never be in both, nor in neither. `warningFixes` says, by code, where
  on the ficha a band warning is fixed (a tab and a field: «Ver operaciones»). Both are
  typed by `HoldingWarningCode`, the codes `collectWarnings` raises.
- **`rows`: the row a terminal added is pointed at.** By list (`RowList`:
  `operaciones`, `cobros`, `recurrentes`), the keys each tab lists; the island compares
  one render with the next (`fresh-row-keys.ts`) and marks the one new key of a list.
  A recurring cobro is its own list because it adds several occurrences to the grid,
  or none yet.
- **`FichaAction.again`: «Añadir otra».** An action that offers it gets, after its
  success lands, an offer in the notice to reopen the same form with the date and the
  currency of the one just sent (`ficha-landing.ts`, `ficha-again.ts`).
- **`errorTargets`, one per form.** A refusal that comes back on the URL reopens the
  form that produced it. Forms that share a surface keep distinct `formId`s so their
  refusals can land in different places — the Cobros entry's one-off and recurring
  forms reopen the «Añadir cobro» panel, the record's controls print on its tab
  (`cobro-form-ids.ts`).
- **One way into the ficha from a link.** `FichaLink` asks for a tab, a field or an
  action's panel through a cancelable window event that the island claims
  (`claimFichaOpen`) — an event and not a context because the warnings band sits
  outside the island. A ficha that does not offer what the link asks for leaves the
  click to the link's real `href`.
- **The island is split by concern.** `ficha-view.ts` is the URL contract,
  `ficha-landing.ts` the landing after a registration, `ficha-strip.tsx` the action
  bar kept at hand, and `holding-ficha.tsx` the view and the panel.

## Amendment (#1850): every family is on the tabbed ficha

With the stored (#1846), housing (#1847), debt (#1848) and mirror (#1849) families
moved, no family returns a `body`, so the accordion went with the last of them, as the
#1826 amendment said it would:

- **One layout.** `HoldingSurface` carries `ficha: FichaLayout`; `SurfaceLayout` and
  its `advanced` branch are gone, and the page has one render path — it no longer
  looks at a layout kind.
- **What only the accordion used is gone with it.** `PayoutsPanel.section` and
  `CobrosSection` (the Cobros panel is its record and its entry only), and the value
  and balance forms of «Lo básico» — the value one printed for every non-derived
  method, the balance one behind the `showRawBalanceForm` flag: «Actualizar valor»
  and «Actualizar saldo» are actions of the bar, and «Lo básico» is the holding's
  identity.
- **The surface no longer carries `operations`.** Each family reads its warnings once
  (`holdingWarnings`) and hands them back in `FichaLayout.warnings`, so the page has
  no ledger to fold.
- **A family names its own self-printing forms.** The page's list of forms that print
  their own refusal keeps only the chrome's (the Cobros panel, the Papelera); a
  family's own (`operation`, `transfer`, a valuation anchor, a disconnect…) are in its
  `FichaLayout.ownErrorForms`, so the page imports no family's form ids.
