# Geography remainder is unknown, not «Otros»

- Status: accepted
- Date: 2026-08-19
- Issue: #1499
- Supersedes / amends: the "remainder is an implicit `other`" bullet of
  [ADR 0039](0039-exposure-profiles-and-present-time-look-through.md), for
  geography and currency. Sector already partitioned this way
  ([ADR 0065](0065-sector-industry-is-an-equity-scaled-lookthrough-dimension.md)).

## Context

`allocateBreakdown` stuffed any undeclared remainder of a geography (or currency)
vector into the `other` bucket and counted the whole holding as classified. A
fund that declares geography to 0,74 therefore painted 26 % as «Otros países»
and showed 100 % coverage, while `profileNeedsCategorizing` still flagged it as
pending. The two surfaces contradicted each other.

`other` already means something else: a country outside the five MSCI-style
regions (Canada, Israel, Korea). Gold and the cash sleeve of a mixed fund have
*no* country. Dumping that fraction into «Otros» is the lie #1452 refused to
write by hand onto a 100 % commodity ficha — and a mixed fund cannot use that
whole-ficha exemption.

## Decision

**Geography and currency partition a holding the way sector already does.**

Per holding of value `V` with declared coverage `Σ` (including reserved keys):

- classified = `V ×` declared taxonomy / ISO weights (`other` only when declared)
- notApplicable = `V × sin_region` (geography) or `V × sin_divisa` (currency)
- unknown = `V × (1 − Σ)`

The three parts always sum to `V`. `sin_region` / `sin_divisa` are reserved
destinations in the stored vector, never chart buckets and never members of the
region enum. Whole-ficha #1452 exemptions (100 % commodity/crypto, cash,
precious metal) stay whole-holding `notApplicable` when no vector is stored.

Asset class is unchanged: its under-100 % remainder still goes to `other` for
the returns decomposition (#552).

## Consequences

- The coverage box and the «por categorizar» filter say the same thing: what
  the filter calls pending is what the chart calls `unknown`.
- An explicit `other: 0.05` still paints 5 % in «Otros». The bucket is not
  removed; it stops being the dump for the remainder.
- Catalog fichas do not need rewriting for the remainder to become honest. A
  mixed fund that wants to leave the filter declares `sin_region` (and
  `sin_divisa`) for the sleeve that has no country.
