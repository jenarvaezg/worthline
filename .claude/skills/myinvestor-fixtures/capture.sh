#!/usr/bin/env bash
# Raw capture (GET only) of every response the MyInvestor connector reads (#1887).
#
#   .claude/skills/myinvestor-fixtures/capture.sh [OUT] [CLI]
#
# OUT  where the raw .json files go. Default: .local/myinvestor-raw of the MAIN checkout,
#      which git ignores. Never point it inside a tracked folder.
# CLI  a checkout of myinvestor-cli with a live session (`myinvestor status`);
#      default: $MYINVESTOR_CLI_DIR.
#
# Read-only against MyInvestor: no write, no cash movement, no window of more than 89
# days that asks for a signature. If the CLI session asks for an SMS, stop and ask
# the owner of the account.
set -uo pipefail

OUT=${1:-"$(git rev-parse --path-format=absolute --git-common-dir)/../.local/myinvestor-raw"}
CLI=${2:-${MYINVESTOR_CLI_DIR:?"pass the myinvestor-cli checkout as the second argument or MYINVESTOR_CLI_DIR"}}
mkdir -p "$OUT"
chmod 700 "$OUT"
C="/cperf-server/api"
TODAY=$(date +%Y%m%d)
TODAY_DASH=$(date +%Y-%m-%d)

raw() { # raw <file> <path> [param=value...]
  local file="$1" path="$2"
  shift 2
  local args=()
  for p in "$@"; do args+=(-p "$p"); done
  (cd "$CLI" && uv run --quiet myinvestor raw "$path" ${args[@]+"${args[@]}"} -f json) \
    >"$OUT/$file.json" 2>"$OUT/$file.err"
  echo "$file: exit $? ($(wc -c <"$OUT/$file.json") bytes)"
}

ids() { jq -r '.payload.data[].accountId' "$OUT/$1.json" 2>/dev/null; }

# Captured for the leak check only (the plan leaves them out of git): the customer profile and
# the day-by-day cash balance.
raw customer "$C/v3/customers/self"
raw cash-historical-balance "$C/v2/cash-accounts/historical-balance" accountTypes=CASH_ACCOUNT

raw cash-accounts "$C/v2/cash-accounts/self"
raw securities-accounts "$C/v2/securities-accounts/self-basic"
raw pension-accounts "$C/v2/pension-accounts/self"
raw automatic-contributions "$C/v2/automatic-contributions/self"
raw portfolios "$C/v2/portfolios"

for id in $(ids securities-accounts); do
  raw "securities-account-$id" "$C/v2/securities-accounts/$id"
  raw "securities-orders-$id" "$C/v3/securities-accounts/$id/orders" dateFrom=2000-01-01 dateTo="$TODAY_DASH"
  # Captured for the leak check and for the prices of the rebuild; never committed.
  raw "securities-positions-$id" "$C/v2/securities-accounts/$id/positions" groupType=SINCE_BEGINNING
  raw "securities-transfers-pending-$id" "$C/v2/securities-accounts/$id/transfers/pending"
  # Stocks, ETF and ETC are not in the orders above: the broker lists them, and each
  # order's execution (ISIN, shares, price, fees) is in its detail.
  raw "broker-orders-$id" "/broker/v2/stock-orders" stockAccountId="$id" type=ALL dateFrom=2000-01-01 dateTo="$TODAY_DASH"
  for oid in $(jq -r '(.payload.data // [])[]? | .id // empty' "$OUT/broker-orders-$id.json" 2>/dev/null); do
    raw "broker-order-detail-$oid" "/broker/v2/stock-orders/$oid"
  done
done

for id in $(ids pension-accounts); do
  raw "pension-account-$id" "$C/v2/pension-accounts/$id"
  raw "pension-orders-$id" "$C/v2/pension-accounts/$id/orders" dateFrom=20000101 dateTo="$TODAY"
  raw "pension-positions-$id" "$C/v2/pension-accounts/$id/positions" groupType=SINCE_BEGINNING
done

echo "--- done in $OUT"
