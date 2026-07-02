# Statements route by ISIN across the portfolio (partially supersedes ADR 0018)

## Context

ADR 0018 shaped the broker **statement** as strictly per-investment: one file, one
ISIN, uploaded against one chosen investment, with an ISIN guard that rejects a
file with mixed ISINs. That was the right v1 — it made a wrong-file slip an
obvious error — but it encodes an assumption the first real external user
immediately broke: brokers export the _whole account_. A MyInvestor "Órdenes"
export carries every order across every fund (a real sample: 153 orders across
26 ISINs, columns exactly as ADR 0018 documents, with **no fund-name column —
only ISIN**). Under the per-investment contract that file demands 26 manual
holding creations plus 26 filtered uploads; the user's verdict was "estamos
locos", and he is right: the file already contains everything needed to
reconstruct the full history.

What ADR 0018 got right and must survive: the merge-by-date semantics (file wins
on overlapping dates, absent dates never deleted), executed-rows-only,
preview-then-confirm, and the ripple discipline.

## Decision

A **statement** upload accepts any mix of ISINs and routes rows across the
portfolio:

1. **Group by ISIN.** The parsed rows split into per-ISIN groups. Each group
   resolves to one of three buckets in a single preview: _matched_ (an existing
   investment carries that ISIN — merge preview exactly as ADR 0018), _new_
   (no investment has it — a creation row), or _ignored_ (the user excludes the
   fund; not everything at a broker is worth tracking).
2. **Creation rows are prefilled by live symbol lookup keyed on the ISIN** (the
   add-holding wizard's search), because the export has no name column: the
   lookup turns `LU…` into a named, priced investment; when it resolves nothing,
   the name and provider symbol stay hand-editable and may be left empty.
3. **An investment created without a provider symbol is an honest, flagged
   state**: it values at its last operation's price and raises an overrideable
   `MISSING_PROVIDER_SYMBOL` **warning** ("pending task" — set the symbol later;
   override it for hand-quoted funds). The warning applies to any investment
   without a symbol, not only imported ones.
4. **Confirm applies the included funds all-or-nothing.** ADR 0018's atomicity
   moves from "the file" to "the confirmed selection": one unresolvable ISIN is
   excluded and resolved later instead of blocking the other 25. Within the
   confirmation everything applies or nothing does.
5. **Entry points:** the portfolio level ("Importar extracto" on the portfolio
   and in the add-holding wizard) accepts any mix; the existing per-holding
   upload remains as the one-fund case of the same engine, its guard reduced to
   "every row's ISIN must match this holding" (backfilling an empty ISIN as
   today).
6. **Idempotent by construction:** re-uploading the same full export is a no-op
   — merge-by-date already guarantees it; creation rows match instead of
   duplicating on the second pass.

Merge semantics, executed-rows-only, sell handling, and ripple behavior are
unchanged from ADR 0018.

## Considered options

- **Portfolio-level ISIN routing with creation and per-fund selection (chosen).**
  One upload reconstructs an account's history; the real file drives the design.
- **Keep per-investment uploads, improve the rejection message.** Rejected: a
  better apology is still 52 manual steps for a 26-fund account.
- **Auto-create every unknown ISIN without a mapping step.** Rejected: nameless
  `LU…` holdings and untracked-on-purpose funds need the explicit
  match/create/ignore preview; silent creation buries mistakes.
- **All-or-nothing over the whole file.** Rejected: one unresolvable ISIN would
  hostage 25 resolvable funds; the selection is the honest atomic unit.

## Consequences

- ADR 0018 is **partially superseded**: its single-ISIN entry contract (one
  file, one chosen investment, reject mixed ISINs) is replaced by this routing;
  its merge-by-date, preview-then-confirm, and ripple semantics remain accepted
  and are unchanged.
- `CONTEXT.md`'s **Statement** entry is re-worded: a statement lists one fund's
  or a whole account's movements; per-holding upload is the one-fund case.
- The `MISSING_PROVIDER_SYMBOL` warning lands on the existing warnings system
  (per-holding, overrideable) and flows into data-quality signals automatically
  when the shared engine unifies them.
- Real broker exports never enter the repository (public repo): test fixtures
  are synthetic files with the same shape.
