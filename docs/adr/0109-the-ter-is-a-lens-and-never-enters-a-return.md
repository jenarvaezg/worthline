# The TER is a lens and never enters a return

## Context

Every exposure profile in the global catalog (ADR 0058) carries a TER, and until
#1717 nothing read it. The feature asked for is a line in the exposure section of
/patrimonio: what the portfolio costs a year — the value-weighted mean TER and its
reading in euros (Σ value × TER) — with the look-through's coverage honesty (ADR
0039): say which share of gross the figure rests on, and never count a missing TER
as 0.

The danger sits next to the feature. A fund's net asset value is already net of its
ongoing charges: the TER is taken out of the fund every day, before the price the
app reads. A return that subtracted the TER again — "net of fees", "after costs" —
would charge it twice and print a portfolio worse than the one held. Once the TER is
an aggregated number on screen, subtracting it from a rentabilidad is the obvious
next change, and it is wrong.

A guard by name does not hold that line. The returns modules of this repo are not
all called `returns*`: `benchmark-comparison.ts`, `holding-benchmark-comparison.ts`
and the `fire-*` rate modules measure or assume returns too, and so do web view
models (`agent-view/returns.ts`, `carteras-returns-view.ts`). The one written next
month is on no list.

## Decision

1. **The TER is a lens, never a figure the math reads.** It is read by the
   portfolio-cost lens (`portfolioCost`, `packages/domain/src/portfolio-cost.ts`),
   which takes the look-through's own input — the same rows, gross and catalog — so
   the coverage it declares is over the same gross the exposure section shows. No
   return, net worth, snapshot or FIRE projection reads it.

2. **A closed list enforces it, not a name.** `tests/portfolio-cost-ter.guardian.test.ts`
   walks every production file of the app, the packages and the scripts and keeps
   two closed lists: the files that may reach the lens (by naming one of its exports
   or importing its module, statically or with a dynamic `import()`) and the files
   that may mention a `ter` field at all (the catalog, its migrations, the profile
   validation, the admin editor, the agent view's profile readout, and the lens).
   Any other file that touches either fails the gate until someone adds it on
   purpose — the moment to ask whether it is computing a return. A file that leaves
   a list fails too, so the allowance cannot rot.

3. **Coverage, in the glossary's trio.** A holding whose profile declares a TER is
   **declared** (a declared `0` is a fact and counts). A fund wrapper — every
   look-through instrument but the directly held share (`FUND_WRAPPER_INSTRUMENTS`,
   derived from `INVESTMENT_PROFILE_INSTRUMENTS`) — without one is **undeclared**:
   the gap, never summed as 0, which would print a cheaper portfolio than the one
   held. So is a managed portfolio's **undetailed aggregate** (#1810): it is
   stored as an `other`, but it is funds nobody enumerated, so it is decided by
   member identity (`managedPortfolioMemberRoles`), never by the label — an
   `other` outside a portfolio stays not applicable, and the portfolio's cash box
   is cash. Cash, property, crypto, metals, coins and a directly held share have no
   ongoing charge and are **not applicable**. With nothing declared there is no
   mean to print: it is `null`, never «0 %».

4. **A declared TER wins over the instrument label.** If the catalog declares a TER
   for a holding typed `stock`, it is priced: the TER is a fact about the security,
   the instrument is a coarse label the user may have got wrong. Waving a declared
   charge away because of the label would under-report the cost.

5. **FX stays upstream.** The lens never sees a native foreign amount: a holding's
   `valueMinor` is already in the base currency, converted by the FX layer (#1065)
   when the projection built its rows, and its `currency` is its real denomination
   (exposure information). A position the FX layer cannot convert is out of the
   projection's gross, and so out of the look-through and of the cost alike.

## Considered options

- **Subtract the TER from the displayed returns ("net of fees") (rejected).** The
  NAV already discounts it; this would count it twice.
- **Guard the returns modules by name (rejected).** Tried first in #1717: a
  `*return*` filter missed the benchmark and FIRE modules and every web view model,
  read only each file's own source, and did not see a dynamic `import()`.
- **Count an undeclared TER as 0, or estimate it from similar funds (rejected).**
  Both invent a figure. The catalog is admin-curated (ADR 0058): a missing TER shows
  in /admin/catalogo, where it can be filled, and in the coverage, where it is
  visible.
- **Treat a directly held share as undeclared (rejected).** A share has no ongoing
  charge; it would read as a gap forever unless someone typed 0 for every stock.

## Consequences

- The exposure section shows «Tu cartera cuesta ~X €/año (TER medio Y %, sobre el
  Z % de lo que cobra TER)» with Con TER / No aplica / Sin declarar beneath it, once,
  outside the full-portfolio / equity lens, like the currency risk. Z is over
  declared + undeclared (see the #1840 amendment).
- Adding a new place that reads the TER — an agent tool, a simulator (#1714) — is a
  one-line, reviewed change to the guardian's list, not a silent import.
- Passing the real denomination into the look-through rows also makes a directly
  held foreign position show as currency risk on /patrimonio, as ADR 0039 always
  described.
- Resolved by the #1840 amendment: the coverage share was first over the whole
  gross, cash included; it is now over declared + undeclared.
- Other fees the model does not know (custody, brokerage) are not part of the cost.

## Amendment (#1840): the coverage share is over what charges a TER

`declaredShare` is `declared / (declared + undeclared)`; what is **not applicable**
is out of the base. With `declared + undeclared = 0` it stays `"0"`, as there is no
mean to print. The field keeps its name.

Why: what is not applicable cannot add a euro to the cost, so it says nothing about
how complete the figure is. Over the whole gross a complete portfolio never reads
100 %: a 250.000 € flat next to 80.000 € in funds that all declare a TER read as
24 % of gross with a figure, which reads as 76 % without one. The line
now says «sobre el Z % de lo que cobra TER», the same words as «Nada en esta cartera
cobra TER». A managed portfolio's undetailed aggregate (#1810) is undeclared, so it
is in the base.

The Con TER / No aplica / Sin declarar trio in euros stays over the gross: it is the
look-through's coverage readout, and the house still shows there as not applicable.
