# Sector/industry is an equity-scaled look-through dimension

> Planned as "ADR 0062" in [PRD #1018](https://github.com/jenarvaezg/worthline/issues/1018); that number was already taken by the batch-provenance ADR, so this is **0065**.

## Context

worthline already looks through investments along three exposure dimensions — **geography**, underlying **currency** and **asset class** — via a shared, admin-curated global catalog keyed by `isin ?? providerSymbol` ([ADR 0058](0058-exposure-profiles-are-a-global-admin-curated-catalog.md)), aggregated present-time by `lookThroughExposure` ([ADR 0039](0039-exposure-profiles-and-present-time-look-through.md)). Jose asked for **sector/industry** exposure too ("defensive, weapons, tech, pharma") on top of the geographic risk view.

The composition axes differ in kind, and sector is not geography-shaped:

- Sector only means something for the **equity part** of a holding. A 60/40 fund's bond sleeve has no GICS sector; its cash has none. A geography vector is read whole-fund; a sector vector cannot be.
- There is **no free feed** for constituent sectors (paywalled, Morningstar-class), so the vector is hand-entered — which forces a **coarse** taxonomy, exactly as geography is coarse.
- "Defensive vs cyclical" is a lens users think in, but it is not a partition you can hand-enter without double-counting: it is a *view* over the sector vector.

## Decision

Add **sector** as a fourth look-through dimension — analogous to geography in plumbing, distinct in semantics — **v1 look-through only** (no drift, no forecast, no thematic screening).

- **Taxonomy — the 11 GICS level-1 sectors as a fixed canonical enum** (`energy, materials, industrials, consumer_discretionary, consumer_staples, health_care, financials, information_technology, communication_services, utilities, real_estate`). Coarse like geography because entry is manual. i18n mirrors geography: the enum plus co-located Spanish labels. [#1002]

- **Vector semantics = relative to the equity sleeve, not whole-fund.** The stored sector vector sums to **≤ 1 over the holding's equity part**, *not* over the whole fund as geography/assetClass do. This is stated explicitly so no consumer assumes whole-fund: a fund that is 50% equity with an all-tech equity sleeve stores `{ information_technology: 1 }`, and the engine (S2) scales that by the equity weight to reach 50% of the holding. [#1004]

- **Coverage is equity-weighted and fractional per holding.** Sector applies only to equity; the non-equity part is `notApplicable`, never `unknown`. Per holding, with `equityWeight` the equity fraction and `Σweights` the declared sector coverage:
  - € per sector = `value × equityWeight × weight`
  - classified = `value × equityWeight × Σweights`
  - unknown (equity with no / under-100% sector vector) = `value × equityWeight × (1 − Σweights)`
  - notApplicable = `value × (1 − equityWeight)`

  `equityWeight` is **derived from the holding's own `assetClass` vector** — no new stored field. A holding with no declared asset class resolves to sector `unknown`; a bare stock auto-derives `equity = 100%`. This coupling is a **read-time derivation inside the engine**: each dimension's storage stays independent, respecting ADR 0039. The engine gains a sector-specific scaling step (`× equityWeight`); it is **not** the flat currency path. [#1002, #1003]

- **Domain shape = extend the closed `ExposureDimension` union** with `"sector"` (do not generalise to an open set). The engine is already generic over `dimension`; what is closed are the *type surfaces*, and there the closed union is a feature — the compiler enumerates every consumer. YAGNI: there is no fifth dimension in sight. [#1003]

- **"Defensive" is a canonicalised derived lens, never a bucket.** Defensive = `{ consumer_staples, utilities, health_care }`; cyclical = every other sector. It is computed from the sector vector (`sectorStyleSplit`), shown as a derived chip line in read *and* edit, and can never be stored, edited, or drawn as a bar. [#1002]

- **Curation = admin-curated on the same global-catalog row** (ADR 0058), hand-entered from the fund detail, read-only for workspaces. It inherits the [#940](https://github.com/jenarvaezg/worthline/issues/940) contract (weights 0–1, sum ≤ 1, the under-100% remainder is unknown). There is **no per-row `source`** — this ADR **supersedes that point of ADR 0058** in favour of the `createdAt`/`updatedAt` stamps the #940 contract already carries. v1 is manual only; agent-draft is deferred. [#1004]

## Consequences

- The domain foundation (this slice, S1) is purely additive: `EXPOSURE_SECTOR_BUCKETS` / `ExposureSectorBucket`, the extended union, `sector?` on `ExposureBreakdowns`, Spanish labels, the defensive set and the pure `sectorStyleSplit` lens. Because no consumer keys a `Record<ExposureDimension, …>`, widening the union compiles cleanly; the sector column stays inert until the engine (S2) reads it.
- The engine must special-case sector's `× equityWeight` scaling and its equity-only coverage — it cannot reuse the whole-fund geography/currency path.
- **Out of v1 (with tripwires):** sector drift/forecast (`exposure-drift-projection.ts` and the agent-view drift point are untouched), thematic/values screening (a different shape — overlapping screens, not a 100% partition), agent-drafted sector vectors, and per-position constituent depth.
