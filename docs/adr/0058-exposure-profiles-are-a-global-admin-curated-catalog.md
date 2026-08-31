# Exposure profiles are a global admin-curated catalog

An exposure profile describes what a security _holds underneath_ — its geography, underlying-currency and asset-class breakdowns, plus TER, tracked index and hedged flag — keyed by `isin ?? providerSymbol`. That composition is a property of the **security identity**, not of any one holder: two workspaces that both hold `IE00B4L5Y983` share the same MSCI World underneath. So the profile is **global reference data**, and asking every workspace to hand-enter (or agent-fill) the same breakdown was the wrong scope. ADR 0039 shipped it per-workspace as the pragmatic v1; this ADR moves it to where the data belongs.

Exposure profiles become a **shared catalog in the control plane**, curated by the admin and **read-only to workspaces**. A workspace's look-through reads the global catalog to classify its holdings; it never writes profiles. This is the control plane's **first reference-data catalog** — until now it held only tenancy plumbing (workspace registry, grants, the daily-capture cron, the chat rate-limit counter). That step is justified because a profile is **non-figure metadata** (ADR 0039): it has no reconciliation invariant, is never read by net-worth / snapshot / ripple math, and its worst failure is a mislabeled geography that is visible and reversible in the look-through. The catalog is keyed by `isin ?? providerSymbol` and each row keeps its provenance stamp (`source`, `declaredAt`).

Writes are **admin-only**. The admin curates the catalog directly, and may reuse the ADR 0044 preview/confirm proposal mechanism as an admin-gated tool that drafts against the global catalog. The end-user agent-fill offer (ADR 0053 amendment, the `list_exposure_profile_fill_targets` / `propose_exposure_profiles` end-user path) is **removed**: end users neither fill nor propose profiles — they read the shared catalog. There is **no per-workspace override in v1** — YAGNI; the stable key leaves room to add an override row later if a genuine per-workspace disagreement ever surfaces, but v1 is global-only.

Migration seeds the global catalog from the existing per-workspace `exposure_profiles` rows (only the seeded/real workspace carries hand-entered profiles today, so this is a one-shot), after which the per-workspace table stops being the source of truth for the look-through. This ADR supersedes the per-workspace hand-entry decision in ADR 0039 and narrows the ADR 0044 / 0053-amendment proposal path (for exposure profiles) to an admin surface. A future benchmark-series catalog (#546) should follow the same shape: shared reference data lives in the control plane, not duplicated per workspace.

## Amendment (#1097): identity registration is a system action, distinct from data curation

The catalog started empty and only ever filled by hand, so `/admin/catalogo` showed nothing even with real holdings in every workspace — the admin had no row to classify. This amendment splits the write surface into two kinds:

- **Data curation** (breakdowns, TER, tracked index, hedged flag) stays **admin-only**, exactly as above. `createGlobalExposureProfile` / `updateGlobalExposureProfile` remain the only writers of profile _content_.
- **Identity registration** — creating the _empty_ catalog row for a security identity — is a **system action**. When a market holding is persisted (`fund/etf/stock/index/pension_plan`, keyed by `isin ?? providerSymbol`), the system registers an empty stub for its identity via a dedicated, idempotent, non-destructive primitive (`ensureGlobalExposureProfileStub`): it creates the row if absent and never touches an existing one, so it can never overwrite curated data or a prior stub. The row is born empty and surfaces in the existing «por categorizar» filter; the admin curates it when they choose.

This preserves the #1014 surface guardian: workspace code still must not write profile _content_ (`store.exposureProfiles.*`, `createExposureProfile(`, …). System stub-registration goes through the separate control-plane primitive, carries no content, and is therefore not curation — the guardian's intent, not just its regexes, is respected.

The stub is registered **best-effort**: a control-plane outage never blocks or fails the holding write that triggered it (the stub is created on the next write or sync touching the same identity, since registration is idempotent). Non-market holdings (cash, property, crypto, coins) have no catalog identity, so connected sources — which yield only crypto/coins today — register nothing; a future fund-yielding source flows through the same derivation for free. The per-workspace override remains out of scope (YAGNI, unchanged).

Holdings that predate this seam are seeded by a **one-shot backfill** (`scripts/backfill-exposure-catalog-stubs.ts`): it walks the control plane's workspace registry, reads each workspace's investment assets, derives their identities through the same pure helper, and registers stubs — idempotent and non-destructive, so it never touches a curated row and re-running is a no-op. (An earlier iteration deferred this to purely organic population; the backfill was added so the catalog is complete on day one rather than filling in over weeks.)

## Amendment (#1508): a row declares its own provenance, or declares that it has none

The original decision above promised that «each row keeps its provenance stamp
(`source`, `declaredAt`)». It never shipped: the table stored **what** each
vector says and nothing about **what it is worth**. So a vector read to the
decimal off the MSCI factsheet, a vector derived from a pension plan's only
public monthly sheet — dated April 2024 — and a vector that described a fund's
*mandate* instead of its portfolio (Palm Harbour: 15% to the US in a fund with
no US at all, 31% of emerging markets omitted, over 10.417 € of real net worth)
were indistinguishable in `/admin/catalogo`. The catalog pass workshop did record
all three facts per entry, and `seed.ts` threw them away on the way in, because
there were no columns to put them in.

The promise is now three nullable columns on `global_exposure_profiles`, and the
same three fields on the domain's content contract:

- **`confidence`** — `alta` | `media` | `baja`, with the meaning the pass already
  uses: verifiable factsheet / issuer breakdown with a translated taxonomy /
  reading of the mandate.
- **`as_of_date`** — the cut-off day of the DATA (`YYYY-MM-DD`), **not** the day it
  was written. `updated_at` already records the write; only a declared cut-off can
  age a vector, which is what turns «¿qué vector se ha podrido?» into an `ORDER BY`.
- **`sources`** — short free text naming where it came from («factsheet MSCI
  31/07/2026», «ficha mensual de la gestora», «quefondos»).

Three consequences are deliberate:

- **There is no backfill and no default.** A pre-#1508 row reads «sin declarar»,
  which is the truth about it. Inventing a confidence would recreate exactly the
  problem this amendment fixes — a number that looks as solid as a factsheet.
- **Provenance is not content.** A profile whose only filled field is its own
  provenance is still «completely empty» and rejected: «confianza baja a fecha de
  abril de 2024» describes a vector, so there has to be a vector. Which also means
  `ensureGlobalExposureProfileStub` keeps writing rows with all three null.
- **The cut-off date never comes from the clock.** It is declared data, so
  re-running the pass with the same proposal re-writes the same day and the seed
  stays idempotent on it. The corollary is a trap worth naming: `updateGlobal
  ExposureProfile` is an ATOMIC FULL REPLACE, as it always has been, so **any
  writer must resend the provenance or it blanks it** — including the catalog-pass
  `seed.ts`, whose entries already carry `confidence` and `sources` and now have
  columns to land in.
- **An unreadable cut-off counts as stale, not as fresh.** The column is plain
  TEXT written by an out-of-repo pass, so the triage lens treats a day that does
  not exist the same as an absent one: it lands where a human is asked to look.
  The list prints such a value verbatim rather than prettifying it into a date it
  is not.

The admin list gains the two triage lenses this makes possible, beside the
existing «por categorizar»: **baja o sin declarar** and **corte antiguo o sin
fecha** (older than twelve months). Each lens folds the undeclared rows in — they
answer the same operational question, «¿me puedo fiar de esta cifra?» — and each
one SAYS SO in its label and counter, so a counter never asserts «de confianza
baja» about a row that merely lacks a declaration. An undeclared cut-off counts
as aged on purpose: a vector with no date cannot be shown to be fresh.

**Which rows and in what order are two separate questions.** The lens filters;
the four orders (identity, declared coverage, confidence, cut-off antiquity) are
chosen independently and apply to «todos» as well, so the register can be read
by confidence or by antiquity **without dropping a single row** — the column
header is the control, and the choice is mirrored in the URL as `orden`.
Staleness is measured against a `today` the page passes in, so the triage module
stays pure and clock-free (ADR 0036 §7).

## Amendment (#1453): the key trusts only what an ISIN is

The `isin ?? providerSymbol` rule above is now, on both sides, «a **valid** ISIN
when the column carries one, else the provider symbol». A pension plan's DGS code
stored in the `isin` column made the two halves of the rule diverge: the
registration identity validated (ISO 6166 check digit) and fell back to the
symbol, while the look-through key read the raw column and searched under the
code — the catalog had the row, the holding rendered «sin clasificar», nothing
warned. `exposureLookthroughKey` now applies the same `validIsinOrNull`
normalization the registration identity uses, so the stored key and the lookup
key cannot disagree; and the interactive identity writes (`createInvestmentAsset`,
`updateInvestmentAsset`, `backfillInvestmentIsin`, `patchInvestmentIdentity`, the
assistant's draft) refuse a non-ISIN at the door. The workspace-document import
stays exempt — a restore preserves the document as-is — which is safe precisely
because the reading key validates.
