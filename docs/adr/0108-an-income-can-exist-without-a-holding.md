# An income can exist without a holding

A public pension or salary should not require an invented asset. For #1672 (S1 of
#1522), **income** absorbs the payout schedule: the holding becomes an optional
link, while the same recurrence engine and write path remain. This amends ADR 0054's
holding-bound declaration and ADR 0076's implicit passive, real classification.

The declaration carries `holding_id` (nullable), `label`, `amount_minor`,
`expenses_minor`, `cadence`, `start_date`, `end_date`, `exclusions_json`, and:

| Field | Declared values | NULL means |
| --- | --- | --- |
| `nature` | `passive`, `work` | No classification; excluded from figures |
| `amount_basis` | `real`, `nominal` | No basis; excluded with an explanation |
| `assumed_contribution_through` | Date | No contribution condition |
| `provenance` | `official_simulation`, `user_estimate` | No source declared |
| `provenance_as_of` | Cut-off date | No cut-off date declared |

The existing lease declarations travel intact: `lease_regime`, `rent_revision`,
`rent_revision_reference` (the documentary reference label), and
`post_mandatory_term_policy` (#1521, shipped in schema v66). An undeclared value is
never an implicit passive or real default (ADR 0074). Only explicitly passive, real
income enters the existing passive-income figures. A nominal amount is withheld,
never silently converted to real euros.

Schema v71 replaces `payout_schedules` with `incomes`. The migration copies every
declaration, identifier, holding link, window, exclusion, expense and lease term,
seeding only `nature = passive` and `amount_basis = real`: exactly the assumptions
the old calculations already made. The old table is removed. Existing
`PayoutSchedule` and store method names are compatibility names for this single
entity and table, not a parallel declaration path. New writes default missing
declarations to NULL. A linked income keeps the existing holding deletion behavior;
detaching it explicitly first preserves it independently.

ADR 0076's substitution still applies only to linked property holdings. If any
projected income on a property cannot be read as passive and real, none of that
property's declared income substitutes its rung return: the all-or-nothing rule
survives. An unlinked income has no holding return to replace and does not enter
holding payout totals. Its consumption by the dated sustainable-spending card
belongs to S3. `calculateFire` is unchanged.

One-off `payouts` are untouched. Occurrences are still derived only up to today,
never materialized, and future start dates are preserved verbatim (ADR 0054 point 4).
The existing Cobros surface retains the declaration and explains exclusions rather
than presenting undeclared income as passive money received.

The workspace transfer keeps its `payoutSchedules` section for compatibility
(ADR 0010/0015), carrying nullable holding links and every new field. Older
documents default missing declarations to NULL, deliberately unlike the live
database migration: a transfer parser does not invent facts the document lacks.
Declaring standalone income through a new form, requiring provenance there, and
the dated future-income card remain S2/S3 work.
