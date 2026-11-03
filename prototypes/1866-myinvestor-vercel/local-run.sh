#!/usr/bin/env bash
# PROTOTIPO DESECHABLE de #1866: login real desde el Mac con el port a TS. Usuario y device_id salen del
# llavero del CLI; la contraseña la teclea Jose sin eco. Solo se guardan metadatos.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ids="$(cd /Users/jose/jenarvaezg/myinvestor-cli && uv run python -c '
from myinvestor.stores import KeyringSessionStore
s = KeyringSessionStore().load()
print(s.customer_id, s.device_id)')"
read -r MYINVESTOR_CUSTOMER_ID MYINVESTOR_DEVICE_ID <<< "$ids"
read -r -s -p "Contraseña de MyInvestor: " MYINVESTOR_PASSWORD; echo
export MYINVESTOR_CUSTOMER_ID MYINVESTOR_DEVICE_ID MYINVESTOR_PASSWORD
out=/Users/jose/jenarvaezg/worthline/.local/proto-1866-local.json
if [ "${RUNTIME:-bun}" = node ]; then
  # Node no resuelve `./lib/myinvestor.js` a `.ts`: se empaqueta y se ejecuta con el fetch (undici) de Node, como en Vercel.
  bundle="$(mktemp -d)/local-run.mjs"
  bun build "$here/local-run.ts" --target node --outfile "$bundle" > /dev/null
  node "$bundle" > "$out"
else
  bun "$here/local-run.ts" > "$out"
fi
echo "Hecho: resultado (solo metadatos) en $out"
