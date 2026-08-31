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
- A liability inherits its rung from the **identity** of its associated asset, never from
  whether that asset is valued on the date being reconstructed (#1436). A debt's presence in
  a historical snapshot is decided by its OWN dated facts (its baseline/plan date per
  ADR 0056, or its first balance anchor) — a mortgage signed in 2004 belongs in 2004 even
  when the flat that secures it has appraisals only from last month, which is the normal
  shape of a real household. The consequence is accepted deliberately: in that stretch
  housing equity reads as the debt alone (negative), which is the honest reading — the loan
  was real and it is the home's VALUE that is unknown, not the home. What the debt must
  never do is fall to `cash` and eat the liquid net worth, so the rung/`securesHousing`
  classification is resolved against the live asset set (`classificationAssets` in
  `calculateNetWorth` / `buildSnapshotHoldingRows`). Generating a snapshot and recalculating
  one now answer the belongs-here question identically; they did not, and the same date
  carried the debt or not depending on how its snapshot was born.
- Snapshots freeze a holding's rung (ADR 0008); the recut changes the rung vocabulary, so
  existing snapshot-holding rows must be migrated/re-derived.
- FIRE eligibility already keys off an explicit primary-residence flag, not the housing
  tier — so primary-residence becomes a first-class flag on the property instrument,
  decoupled from liquidity.


## Amendment (#1528): the `term-locked` rung finally has somewhere to keep its date

This ADR defines `term-locked` as *«locked until a date or an age»* — and for as long as
it stood alone, that date existed nowhere. There was no column for it, on `assets` or
anywhere else: the rung asserted that there was a plazo and could never say which one.

The consequence was not cosmetic. A pension plan became a **block**, and both of the only
two answers available were false — counting it whole as capital you can sell in slices
promises money the owner cannot touch, and taking it out whole hides money that is already
redeemable. Every downstream reading inherited that, including the reparto that spends
today's capital over a calendar.

`assets.available_from` (ADR 0100) is that date, declared by the owner and never derived
from the book. Two things about it belong here, in the rung's own ADR:

- **The rung owns the field.** Only `term-locked` may carry a date, because it is the only
  rung whose definition mentions one. A holding that moves to another rung leaves its
  declaration **inert rather than wrong** — nothing reads it, nothing deletes it, and
  moving back recovers it as declared.
- **The vocabulary does not grow.** There is still no sixth rung, and no rung is split in
  two. The ladder stays five pure accessibility rungs; what changed is that one of them can
  now answer *«until when?»* instead of only *«not yet»*.

What the date does NOT do is move `term-locked` on the ladder or across the sellable /
immobilized partition — that is a separate question, and it is #1523's to answer.
