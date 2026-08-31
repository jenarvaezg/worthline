# An instrument is corrected within its shape, and re-applies nothing

## Context

Jorge's `/objetivos` showed a fourth line among his three flats, in the card that explains
which properties' declared rent replaced the housing tier's guessed rate:

> **Pensión Pública Seguridad Social Española** — Su alquiler declarado no está vigente hoy…

That section only looks at holdings whose instrument is `property` (`isHousingAsset`). His
public pension was in there because it had been **filed as an inmueble**, and that is not a
copy defect: the instrument decides figures.

- The `housing` rung (`tierOfAsset` overrides the declared availability).
- The housing tier's **3 % default real return** (`TIER_REAL_RETURN_DEFAULTS`), applied to
  something that is not brick.
- The **immobilized side** of the FIRE capital split (`fire-capital-split`: «immobilized is
  illiquid + housing»), so whether it counts as FIRE capital at all was being decided by
  the #1460 checkbox for a false reason.
- The «Vivienda» label on the liquidity ladder, the housing composition, and mortgage
  netting (`securesHousingAsset`).
- The rent notices of #1510/#1511, asking a pension for its letting expenses.

And the product defect underneath: **the instrument could be picked only at the alta.** It
is asked twice on the way in (`anadir/page.tsx`, `anadir/avanzado/page.tsx`), shown as a
grouping axis on `/patrimonio` — so the user *discovers* the misclassification — and
offered nowhere on the ficha. `grep -rn 'name="instrument"'` returned nothing under
`patrimonio/[id]/editar/**`, and no server action of the ficha accepted the field. The only
exit was to delete the holding and create it again, throwing away its history, its declared
payouts and its operations, to fix a label the app reads to decide tramo, expected return
and sellable capital.

## Decision

**The instrument is correctable from the ficha, within the holding's persistence shape, and
the correction re-applies none of the instrument's defaults.**

1. **The picker offers a shape, not the catalog.** An instrument decides how a holding is
   VALUED (`defaultsFor(...).valuationMethod`) and therefore which rows exist under it, so
   `assignableInstruments` (`instrument-correction.ts`) offers only the instruments that
   share the holding's **persistence shape**:

   - `manual` — value on the asset row, hand-set (`stored`) or carried by a revaluation
     curve (`appreciating`). Identified by declaring a legacy `AssetType`. Six members:
     `current_account`, `term_deposit`, `precious_metal`, `vehicle`, `property`, `other`.
   - `investment` — `derived` from an operations ledger and a market price: `fund`, `etf`,
     `stock`, `index`, `pension_plan`, `crypto`.
   - `connected` and `debt` — offered nothing. A synced source owns its own identity (ADR
     0016/0021); a liability's instrument is recoverable from (LiabilityType, DebtModel)
     and is corrected by editing those.

   The shape is read off the catalog's DEFAULTS, never off a list of names: a debt declares
   a `liability`, a manual asset an `assetType`, and what separates the remaining `derived`
   instruments is the **price provider** — an instrument valued from mirrored positions
   declares none (`coin_collection` today). So the next connected instrument lands in
   `connected` by construction instead of surfacing in a picker that would offer to edit
   an identity the source owns.

   Both gates ask the same domain function. `assignableInstrumentsForShape` is the
   shape-keyed form, so the investment ficha's parser — which serves one shape by
   construction and cannot read the row — states the rule instead of paraphrasing it.

   So `property` ↔ `other` is a legal correction — both keep their value on the asset row —
   and `property` → `pension_plan` is not offered: it would promise units × price over a
   ledger that does not exist. Crossing shapes remains a re-alta.

2. **The instrument is authoritative; the legacy `AssetType` is derived from it.** `updateAsset`
   used to re-derive `instrument` from `type` / `isPrimaryResidence`; when the patch carries an
   explicit instrument that direction is inverted (`fields.type = defaultsFor(instrument).assetType`),
   and the ficha stops posting `type` at all. One axis, one writer, in the ADR 0014 direction.

3. **Nothing else is re-applied.** `defaultsFor` suggests a rung, a valuation method and a
   price provider **at the alta**; replaying them over a live holding would overwrite a
   declared availability or a working price symbol to fix a label. So the declared rung
   survives (`instrumentCorrectionMove` takes it as an input rather than deriving it), the
   declared value survives, the price configuration survives, the payouts survive. The
   valuation METHOD does move, because it is a pure function of the instrument — which is
   the point of the correction, and is why the picker is confined to a shape where the
   method's inputs are already there.

4. **Two refusals, both about a figure that would move silently.**
   - An instrument outside the shape (the trust boundary under the picker;
     `parseUpdateInvestmentCommand` checks the shape too, after `isInstrument` — a stray
     string must not index the exhaustive catalog).
   - A **known-partial ownership split** leaving `property`. A 75 %-owned flat is the one
     shape whose ownership may total under 100 % (#171); every other instrument completes
     the shortfall to full ownership on save, so the correction would hand the user the
     missing 25 % of the value. That is a change of net worth dressed as a change of label:
     it is refused, naming the declared percentage, not completed.

     The guard judges the split **as submitted**, never the one on the row
     (`ownershipShortfallOnCorrection` takes `enteredBps`). Reading the stored ownership
     would fail in both directions: a partial arriving in this very submit over a
     fully-owned row would sail through and be completed, and the legitimate save that
     fixes the titularidad and the instrument together would be blocked.

5. **`isPrimaryResidence` is force-cleared off any non-`property` instrument**, in the store
   and in the action. Leaving it set would let the very next type edit re-derive `property`
   (rule 2's old direction, still live for callers that post a type) and silently undo the
   correction. The checkbox is rendered only while the holding IS an inmueble.

## The ripple verdict

**An instrument correction ripples nothing** (#1435's question, asked in #1512 point 2).

- **Every live figure the misclassification moved is derived at read time** from the asset
  row — `tierOfAsset`, the tier's real return, `splitFireCapital`, the ladder labels, the
  rent notices. They are all correct the instant the column is written, which is what the
  screen has to show.
- **Re-rippling would rewrite historical VALUES, not just the classification.** The
  historical snapshot re-valuation dispatches on `isHousingAsset` (`historical-snapshot.ts`),
  so a ripple after a `property` → `other` correction would re-value every past date under
  `stored` instead of the appreciation curve — trading a wrong label for wrong money. The
  existing housing ripple already returns early for a non-housing asset
  (`ripple-engine.ts`), so the correction is a no-op there by construction; the one wiring
  fix was to read the **effective** type in `ownership-facts.ts`, so a holding just promoted
  to `property` takes the housing branch instead of the stale column's.
- **What stays stale is the frozen classification on existing snapshot rows** —
  `snapshot_holdings.liquidity_tier` and `counts_as_housing` (#181). It affects only the
  historical composition and ladder series, and fixing it is a pure column rewrite with no
  re-valuation, which is separable from this decision and deliberately deferred.

## Alternatives considered

- **Re-apply `defaultsFor` on correction (rejected).** #1512 point 4 says it plainly:
  overwriting the valuation method, rung or price provider of a live holding is worse than
  the misclassification. A pension corrected to `other` would land back on `illiquid` — the
  immobilized side again, for a new false reason.
- **Offer the whole catalog and migrate the rows (rejected).** Moving a hand-valued asset
  onto a `derived` instrument means inventing an operations ledger (units, a price, an
  opening date and cost) — the alta's job, with its own gates (#1490/#1505, ADR 0097). A
  picker that quietly did that would be an alta wearing an edit's clothes.
- **Warn with a confirmation step before saving (rejected).** The consequence is one
  sentence long, so it is stated in the form next to the select rather than behind a second
  submit — and the board shows the new instrument, tramo and expected return immediately
  after saving. The two cases that genuinely move money without being visible are refusals
  (rule 4), not warnings.

  The sentence is **computed, not written**: `instrumentPickerImpact` reads the holding's
  own declared rung and answers which of the offers would cross the sellable ↔ immobilized
  frontier. A hand-written note would have had to repeat `TIER_REAL_RETURN_DEFAULTS` as a
  literal and would have been wrong for a flat already on `illiquid`, where nothing
  crosses. One `<InstrumentPicker>` carries it, so neither ficha surface can grow its own
  version of the claim.
- **Ripple the classification into history (deferred, not rejected).** See the verdict: the
  cheap version is a column rewrite over `snapshot_holdings`, and it has no dependency on
  this decision.
- **Model a public pension as `pension_plan` (out of scope).** #1512's own open question is
  the right answer: a lifetime public pension is a **rent flow**, not sellable capital, and
  `pension_plan` in this codebase means `derived` — units × price via a DGS code, which a
  Seguridad Social entitlement has not got. Its home is #1522 («una renta se emancipa del
  activo»). Correcting the instrument is still needed either way, which is why this decision
  stands on its own.
