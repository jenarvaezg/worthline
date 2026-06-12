# Net worth has one canonical headline; framings re-label, they don't add figures

worthline shows a single headline figure — **net worth** (all assets minus all
debts, home equity included) — with an optional **Liquid** framing that only
changes _which_ figure is the hero. Gross assets, debts, housing equity, and
liquid net worth are always-visible breakdown around it, not separate "views".

We considered keeping five equal-weight metric tiles, and keeping the three
presentation modes (`liquid` / `housing-inclusive` / `gross-debt`) as-is, but both
duplicated the same numbers under different labels and gave no 3-second answer to
"what am I worth".

## Consequences

- `NetWorthPresentationMode` collapses toward `{ total, liquid }`.
- **`housing-inclusive` is retired** — it is the same figure as total net worth (see
  `presentNetWorth`, which returned `summary.totalNetWorth` for it). A future reader
  seeing the old three-mode enum should expect it to shrink, not grow.
- **`gross-debt` stops being a mode** — the gross/debt decomposition becomes
  permanent breakdown shown alongside the headline.
