# Finect page fixtures (issue #1357)

Trimmed but **verbatim** captures of live `finect.com` product sheets, taken on
2026-08-16. The Finect provider tests (`packages/pricing/src/providers.test.ts`,
`search.test.ts`) parse these instead of touching the network.

Each file keeps the four parts the parser actually sees — `<title>`, the
`application/ld+json` payload, the visible NAV block, and a slab of the
URL-encoded page copy — with the rest of the ~780 KB page dropped. **Keep the
URL-encoded slabs**: they are the regression, not filler.

| File                         | Captured from                                                        | Pins                                                     |
| ---------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `fund-usd.html`              | `/fondos-inversion/IE00BDZVHT63-Fidelity_msci_pac_ex_jpn_idx_usd_p_acc` | A USD fund: offer `8.6211 USD`, needs FX before it is EUR |
| `pension-plan-eur.html`      | `/planes-pensiones/N5394-Myinvestor_indexado_sp_500_pp`               | A EUR plan: offer `21.64353`, finer than the visible 21,64 |
| `producto-no-disponible.html`| `/planes-pensiones/N9999-Noexiste_plan`                               | The soft-404: HTTP 200, no JSON-LD                        |

## Why the visible price is not a source (the #1357 trap)

The old parser flattened the HTML and took the first `<digits> €|EUR`. Against
these real pages that matched:

- `…clientes%20de%20Europa…` in `fund-usd.html` → **`20Eur`**, i.e. a 20 € NAV
  invented out of a URL-encoded space and the first letters of "Europa". The
  fund's real NAV (`8,62 $`) was skipped because it is not in euros.
- `…%22euribor…` in `producto-no-disponible.html` → **`22eur`**, so a dead
  symbol quoted at 22 € instead of failing.

The JSON-LD offer carries the price, its currency, and full precision. Note the
pension URL 301-redirects to `/fondos-inversion/` for funds — both sections
serve the same sheet, so one base URL covers both.
