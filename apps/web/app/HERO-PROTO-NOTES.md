# PROTOTYPE — hero "hueco" fillers (throwaway)

**Question:** The home hero (8-col) stretches to match the taller Liquidez panel
(4-col), leaving a big empty space under the breakdown stats. What non-redundant
content should fill it?

**Shape:** UI prototype, sub-shape A — variants on the existing `/` route, gated
by `?variant=`, dev-only floating switcher (← / → or click). Hidden in production.

## Decisions so far (round 1 → round 2)

- **Movers = the direction.** Round 2 makes them **per-holding** (was axis-level):
  which holdings moved net worth most since the previous snapshot, ranked by
  **€ impact** (not %, so a small holding's big % swing doesn't crowd the top).
  Debt paid down counts as a positive impact (green = good for you).
- **Hitos — PARKED.** Jose likes it but wants it later, likely **configurable /
  part of the FIRE module** (a "meta de patrimonio" alongside the FIRE number).
  Removed from the prototype; revisit as its own feature.
- **Records rail — DROPPED.** Low value on the home.

## Current variants (per-holding movers) — round 3

- **A — Subieron / Bajaron.** Two columns: top gainers vs top losers (€ + %).
- **B — Ranking.** One list, top movers with a **€ / % toggle** (`?mvu=`) — the
  former B (absolute) and C (matrix %) merged into one, since they were the same
  data with a different unit.

Both respect a **period toggle** (`?mvp=`): **Mes** (vs cierre mensual anterior,
default) · **Año** (YoY). Daily "vs anterior" was DROPPED — it was market noise.

## Files (delete when folding the winner in)

- `apps/web/app/hero-proto-extras.tsx` — variants + switcher
- `page.tsx` — `buildHeroProtoData` + `readProtoHoldingRows` + `parseProtoVariant`
  - the in-`try` holding-row read + render block (search "PROTOTYPE")
- `globals.css` — `PROTOTYPE` block at the end (`.proto*`)

## Data notes / rough edges (iterate)

- Movers diff the frozen holding rows of the **two latest snapshots** (`vs anterior`).
  Period could instead be **vs cierre mensual** (less daily noise) — open question.
- `nuevo` (added since) / `vendido` (gone since) holdings are tagged; a sale shows
  as a big negative mover — accurate but maybe wants its own treatment.
- Líquido membership = the real cash+market rule (`isLiquid` + unsecured-debt→cash),
  decided ONCE per holding from its current row so frozen-flag drift across
  snapshots can't surface a long-standing holding as a phantom "nuevo" (this is
  what made "Deuda Cuñao" pop up at −15.000 € in Líquido — fixed).
- Connected sources (Binance, Numista) are ONE holding each — crypto won't break
  down per-coin here. If you want per-coin, that's a deeper change.

## Verdict

_TBD — Jose to flip A/B/C and decide (rank by € confirmed; period + per-coin open)._
