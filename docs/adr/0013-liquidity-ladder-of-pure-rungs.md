# Liquidity ladder of pure-accessibility rungs

The liquidity classification was a flat set of five "tiers" (cash, market, retirement,
illiquid, housing) that mixed real liquidity with instrument purpose — "retirement" named
_why_ a holding was locked and "housing" named _what_ it was, and neither is a liquidity
level. We recut it into an ordered **liquidity ladder** of four pure-accessibility rungs —
**cash** (available instantly), **market** (realizable in days at minimal cost),
**term-locked** (locked until a date or age), **illiquid** (sellable only with friction or
a haircut, over weeks to months) — where each rung answers only "how quickly and cheaply
does this convert to cash?". The two top rungs remain **liquid net worth**, so ADR 0003 is
untouched. Finer real-world distinctions (a deposit vs a pension; gold vs a flat) live on
the holding's **instrument**, not in extra rungs, and recognisable groupings such as
housing equity are derived from the instrument rather than from a tier.

## Considered options

- **Keep the five tiers and just give term deposits a home** — rejected: it leaves the
  retirement/housing "costumes" and the silent disagreements they caused (housing had three
  non-coincident definitions, across net worth, the valuation curve, and FIRE).
- **A two-dimensional model (time-to-access × haircut)** — rejected as over-engineering for
  a personal tracker; a single ordinal of "effective accessibility" is enough.

## Consequences

- A **liability** also sits on a rung: it inherits the rung of its associated asset
  (netting against it — a mortgage offsets the house on `illiquid`), or **cash** when
  unassociated (a claim on liquid resources for its full balance). This replaces the
  invented default (`tierOfLiability`: mortgage→housing, else→cash) that silently made
  informal loans reduce liquid net worth.
- Snapshots freeze a holding's rung (ADR 0008); the recut changes the rung vocabulary, so
  existing snapshot-holding rows must be migrated/re-derived.
- FIRE eligibility already keys off an explicit primary-residence flag, not the housing
  tier — so primary-residence becomes a first-class flag on the property instrument,
  decoupled from liquidity.
