# An alta is one family and a command per family

## Context

`createHoldingAction` is the one server action that creates any holding worthline
knows: a cuenta corriente, a plazo fijo, a fondo with an opening BUY, a plan de
pensiones that arrived traspasado from another manager, a piso with its
acquisition anchor, a hipoteca declared «por estado actual».

ADR 0014 already settled how that fan-out is decided — the instrument catalog
(`defaultsFor`) owns the rung, the valuation method, the price provider, the
legacy AssetType a stored asset persists as, and how a debt persists. What was
never split was the **action**. It had grown to 988 lines and worked like this:

- Three sequential `if`s over the catalog's answer — `defaults.assetType`, then
  `valuationMethod === "derived"`, then `defaults.liability` — each followed by
  the entire body of that family's alta, inline. The manual-asset path and the
  appreciating one shared the first branch, so the acquisition question of #1561
  was tested for a coche and a cuenta corriente that can never carry a date.
- One flat `FIELD_KEYS` list of every field any pane posts (`trAmount`,
  `csEndDate`, `costMode`, `acqCost`…), suffixed with the chosen instrument to
  refill a rejected alta. Adding a field to one pane meant editing a list the
  other three families also read.
- Two closures, `errorUrl` and `successUrl`, captured over the submission and
  called from every branch — so each family also knew where the wizard returns.

Two costs followed. The first is blast radius: adding an instrument, or a field
to one pane, meant reading and risking all four altas. The second is that the
riskiest part of the file — the investment captures of #597/#1541, which must
resolve BEFORE anything is written (#1599) — sat in the middle of a function
whose other two thirds have nothing to do with them.

## Decision

**An alta is a route, a family, and a command per family. The action
orchestrates; it does not branch on the instrument.**

1. **The family is decided once, in a pure module.** `altaRoute`
   (`anadir/_families/alta-route.ts`) maps an instrument to one of four families
   — `stored`, `housing`, `investment`, `debt` — and is the only place that
   decision is made. It is pure and tested exhaustively over `Instrument`, so an
   instrument that declares no way to persist itself fails the test rather than
   falling into whichever branch happened to be last. It is deliberately NOT the
   ficha's `holdingFamily` (ADR 0095): the ficha routes a holding that exists and
   can be read; the alta routes an instrument the user has just picked.

2. **The route carries what the catalog answered on the way.** The rung, the
   legacy AssetType, the price provider, the liability spec. A command never
   re-derives the fact that sent it there, and none carries a guard for a case it
   cannot be called in — the debt command's liability spec is non-optional.

3. **One dispatch point.** `altaCommandFor` (`_families/alta-dispatch.ts`) is the
   only `switch` on the family.

4. **A family reads only its own pane, validates only its own rules and writes
   only its own rows.** A cuenta corriente resolves no capture; a piso never
   parses an invMode; an inversión never reads the debts' start dates. The
   symmetry extends to the error path: each command declares its own refill
   fields beside itself, so a rejected alta of one family cannot forget a field
   of another and adding a field touches one module.

5. **A command never builds a URL.** It answers with a message, or an
   `AltaCreated` naming the holding, the ok-key, and where the user lands
   (`wizard-or-board` / `holding-ficha`). The action turns that into the
   redirect, because the query string it belongs in — the wizard's `&added=`, the
   board's `#anchor`, the acquisition question's `deudaDesde` — is a property of
   WHERE the alta was submitted from, not of what was created.

6. **The wizard's drawers are translated before any of it.**
   `anadir/simple-drawer-form.ts` rewrites «dinero» + «a plazo» into
   `term_deposit`, «inmueble» into `property` with today's date stamped, and so
   on. Everything downstream reads one shape, `<field>_<instrument>`, and no
   command knows which surface posted it.

**Housing is its own family, not a stored asset with a date.** What separates
them is the write: a property seeds an acquisition anchor, an appreciation rate
and an optional initial valuation, and ripples the histórico from the acquisition
date (PRD #108, ADR 0020); a stored holding writes one row. Only housing can
carry an acquisition date at all — `parseAssetCommandStrict` parses none for
`cash`/`manual` — so the acquisition question of #1561 belongs to it exclusively.

**A Numista collection routes to `null`.** It is `derived` (ADR 0016), so a
method-first switch would offer it the investment alta; but nobody hand-creates
one — it appears by connecting the source, and its rows are mirrored positions.
The add form never offered it; now the routing says so too.

## Consequences

- **Nothing the user does changes.** Same validations, same Spanish messages in
  the same order, same redirects, same writes. The refactor is pinned by the 64
  action-level tests of `create-holding-action.test.ts`, which were not touched.
- **Adding an instrument is a row in the catalog.** At most a field in one
  family; never a branch in the action.
- **Adding a family is a case in the dispatch and a module beside it.** No
  existing family is re-read to make room.
- **The action is 214 lines.** It decides where the submission came from, which
  instrument it chose, which family that is, and how to turn the command's answer
  into a URL.
- **The cost is one indirection.** Reading «what does the alta of a fondo do?»
  now means opening `investment-alta.ts` instead of scrolling to the middle of
  one long function. Same trade ADR 0095 made for the ficha.
- **`investment-alta.ts` is the biggest command**, because «cuánto tienes» really
  is the richest question the alta asks: three mutually-exclusive modes, two of
  which resolve a whole capture before the holding exists (#1599).
- **The families still share their persistence.** `persistManualAssetCreation`
  is called by both asset families and by the assistant's own creation path, and
  `store.command.create*Holding` is the atomic seam of #1599. The split is of the
  ALTA — what is read, validated and decided — not of how a row reaches disk.
