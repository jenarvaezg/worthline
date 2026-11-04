# MyInvestor API fixtures (#1887, PRD #1876)

Responses of the MyInvestor API that the connector reads, for its tests to run without
the network. Each folder has a `manifest.json` that says which request every body
answers (method, path, query and HTTP status); `index.ts` loads both.

| Folder       | Origin                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| `capture/`   | Real responses, anonymized by `bun run fixtures:myinvestor`. Never edit by hand. |
| `synthetic/` | Written by hand: the session (login, SMS, refresh, expired token) and the cases the real account lacks. |

## How `capture/` is anonymized

- Identifiers (IBAN, DNI/NIE, names, account, order, reference and person ids, emails,
  phones, aliases) are replaced by stable fakes: the same real value always gives the
  same fake, also in the file names. Fake IBANs and documents have broken control
  digits on purpose.
- **Amounts are invented**: each distinct real amount gets its own random fake of the
  same order of magnitude, never round, so the same real value keeps the same fake (a
  scheduled contribution and its order, both legs of a switch, a hold and its order) and
  no common factor links them to the real ones.
- **Everything derived is recalculated** from the invented orders: each order's shares
  (amount / real price, at the API's decimals), broker gross and net, today's positions
  (P8 of #1869: they rebuild exactly from the `COMPLETE` orders), invested at average
  cost, values at today's real price, account totals, `withheldBalance` (the sum of
  `amountToBlock` of the orders in progress) and the plans' `SINCE_BEGINNING` series.
  `enabledBalance` has no order behind it and is simply invented.
- ISIN, DGS codes, tickers, operation dates, enums and prices (NAV, share price) are real.
- Left out: the customer profile, the day-by-day cash balance and the securities
  accounts' `SINCE_BEGINNING` series. The connector does not read them.

The procedure and its rules are the skill `.claude/skills/myinvestor-fixtures/`.

## What the API showed (relevant to the connector)

- Fund orders (`/v3/securities-accounts/{id}/orders`) bring funds only. Stocks, ETF and
  ETC come from the broker: `/broker/v2/stock-orders` lists them (no ISIN, no
  execution) and `/broker/v2/stock-orders/{id}` has the ISIN, executed shares, price,
  fees and net. The list's `id` is the detail's `orderReference`.
- `withheldBalance` of a cash account is exactly the `amountToBlock` of its orders in
  progress; `enabledBalance` leaves them out.
- `orderDate` is `AAAA-MM-DDT00:00:00.000+0000` for funds and `AAAA-MM-DD` for plans.
  `expirationDate` (funds) and `effectiveDate` (plans) are not a settlement date.
- A plan's external mobilization in has `cash: 0` and `amountBuyVL: 0`: no cost travels.
- An internal plan transfer is two orders with the same date and amount and no common
  id. A fund switch (`IIC_SWITCH_*`) is the same shape. `INTERNAL_TRANSFER_*` pairs do
  not share date nor amount.
- Positions of a securities account carry `"accountId": "null"`, as text.
