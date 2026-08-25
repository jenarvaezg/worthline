# Runbook: verificación end-to-end del billing de Paddle en sandbox

Slice S6 del PRD #1160 (#1166). El adapter real de Paddle (`apps/web/app/billing/paddle-adapter.ts`)
implementa la interfaz `BillingAdapter` de S5 (#1165); esta guía cubre la config
de sandbox y los cinco escenarios del gate de la beta (#1133: billing vivo el día 1).

## Qué es agnóstico y qué no

El contrato billing→entitlements (ruta de webhook única, idempotencia
record-first, transiciones puras `applyBillingEvent`, re-sync de /admin, página
`/premium`) ya existe desde S5 y **no conoce a Paddle**. S6 solo añade el adapter
concreto y lo registra en `get-billing-adapter.ts` cuando
`WORTHLINE_BILLING_PROVIDER=paddle`.

## Config de sandbox (una vez)

Credenciales en `.local/paddle-sandbox.env` (fuera de git). El bloque de env de
la app está en `apps/web/.env.local` (ver `.env.example` para el catálogo).

1. **Catálogo** (#1137, ya hecho): producto «Worthline Premium» con tres precios
   — mensual `pri_01ky59cg39ph64b1wc6xybj2hw` (4,99€), anual
   `pri_01ky59cg77t5hmj83peqq6zagz` (49€), lifetime
   `pri_01ky59cgbhv99yw0hbbqa0jf2t` (99€ one-time, cupo 50 gestionado en app).
2. **Túnel**: `ngrok http 3000`. La cuenta tiene dominio estático
   (`https://fixed-sina-submundane.ngrok-free.dev`), así que la URL no cambia
   entre sesiones y los dos pasos de dashboard se hacen UNA vez.
3. **Default Payment Link** (REQUERIDO, paso de dashboard, SIN API): Paddle →
   Checkout → Checkout settings → Default payment link =
   `<túnel>/premium/pagar`. Sin él, `transactions.create` falla con
   `transaction_default_checkout_url_not_set` y `checkoutUrl` degrada a null
   (verificado 2026-07-23 y de nuevo 2026-08-25). En sandbox se admite
   `localhost`, pero conviene que sea la ruta real: Paddle usa este valor como
   base de los enlaces que reparte en sus correos de impago y de «actualiza tu
   método de pago».
4. **Client-side token**: Paddle → Developer tools → Authentication →
   Client-side tokens. Va a `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`; lo usa Paddle.js
   en la ruta de pago. **Tiene API**: `paddle.clientTokens.create({name})`.
5. **Destino de notificaciones**: apuntando a `<túnel>/api/billing/webhook`, con
   los eventos de suscripción + `transaction.completed`. El secreto de ESE
   destino es `WORTHLINE_PADDLE_WEBHOOK_SECRET` (ya en `.local`, ntfset
   `ntfset_01ky5hmdsgjvr5r4d4c5kvd6pr`). **Tiene API**:
   `notificationSettings.create` devuelve el secreto, y `update` cambia la URL
   **sin rotarlo** — así que re-apuntar el túnel no toca el env ni el dashboard.

## Dónde vive el checkout (la trampa de Paddle, #1221)

Paddle Billing **no tiene una página de pago propia a la que enlazar**. La
`checkout.url` que devuelve `transactions.create` es el *default payment link*
de la cuenta —una página **tuya** que carga Paddle.js— con `?_ptxn=<txn>`
añadido. Con `https://localhost/` de default payment link, esa URL no abre nada.

Tres salidas, y worthline recorrió las tres en este orden (2026-08-25):

1. **Hosted Checkout de Paddle** (`pay.paddle.io`, la primera elección):
   descartada por Paddle, no por nosotros. *«Hosted checkouts are only available
   for customers with an app-to-web sales funnel, or for embedding the checkout
   in a non-mobile app, such as a desktop application. To request access, please
   contact support.»* worthline no encaja en ninguno de los dos perfiles.
2. **Página propia con Paddle.js** (la elegida): la ruta `/premium/pagar`
   (`CHECKOUT_PATH`), que es a la vez el default payment link de la cuenta.
   `/premium` enlaza a ella con `?tier=…`; ella crea la transacción server-side
   y vuelve a sí misma con `?_ptxn=…`, que es lo que Paddle.js abre en un
   iframe inline. La misma ruta atiende los `_ptxn` que Paddle reparte por
   correo, que es justo lo que el default payment link significa.
3. **Página de pago fuera de la app** (descartada): dejaría la CSP intacta a
   cambio de un artefacto de despliegue nuevo y un salto de dominio en mitad de
   la compra.

### Lo que cuesta en la CSP

El precio de la opción 2 es script de terceros, y se paga **en una sola ruta**:
`next.config.ts` sirve la política cerrada a todo path menos `/premium/pagar`
—con un lookahead negativo, porque dos entradas solapadas darían dos cabeceras
`Content-Security-Policy` y el navegador las intersecta— y a esa ruta le sirve
`securityHeaders({ paddle: true })`, que añade `script-src` (cdn), `frame-src`
(el iframe de pago) y `connect-src` (el checkout service) de Paddle, más
`Permissions-Policy: payment=(self …)` para que los wallets funcionen dentro del
iframe. Los hosts están en `security-headers.ts`; Paddle no publica lista de CSP,
así que se **miden** en el navegador. `security-headers.test.ts` fija que la
política ensanchada no se salga de esa ruta.

Crear la transacción al pulsar (y no al pintar `/premium`) cayó de la misma
pasada: la página abría **tres** transacciones en cada visita, una por carril.

## Mapeo de eventos (adapter → contrato)

Routeado por el ESTADO de la suscripción, no por el nombre del evento, para ser
convergente frente a redeliveries y reordenamientos:

| Payload de Paddle | Estado | Evento del contrato |
|---|---|---|
| `subscription.*` | `active` / `trialing` | `subscription_activated` (`paidUntil = current_billing_period.ends_at`) |
| `subscription.*` | `past_due` | `payment_failed` |
| `subscription.*` | `paused` / `canceled` | `subscription_canceled` (`paidUntil = ends_at ?? null`) |
| `transaction.completed` | one-time, `subscription_id == null`, item = price lifetime | `lifetime_purchased` |
| `transaction.completed` | con `subscription_id` | ignorado (lo poseen los eventos de suscripción) |
| cualquier otro | — | ignorado (200, sin reintento) |

El workspace viaja en `custom_data.workspaceId`, fijado por `checkoutUrl` al
crear la transacción; Paddle lo propaga a la suscripción y a sus webhooks.

**Guard de ordenación (#1166):** `applyBillingEvent` mantiene `premiumUntil`
monótona en la activación (`laterOf`) — una activación stale/fuera de orden con
un fin de periodo anterior nunca regresa el acceso. El acceso lo decide
`deriveEffectivePlan` sobre las fechas, así que un `subscriptionStatus` stale es
cosmético. El crash-window entre registrar-idempotencia y aplicar-transición lo
cubre el re-sync manual de /admin (la red de seguridad del contrato).

## Los cinco escenarios del gate (#1133)

Con la app en `<túnel>` y una [tarjeta de test](https://developer.paddle.com/sdks/sandbox#test-cards)
(`4242 4242 4242 4242`, cualquier fecha futura y CVC):

1. **Mensual** — checkout del tier monthly → `subscription.activated` →
   `deriveEffectivePlan` = premium, `premiumUntil` = fin del primer periodo.
2. **Anual** — igual con el tier annual; `premiumUntil` a ~1 año.
3. **Lifetime** — checkout del tier lifetime → `transaction.completed` one-time →
   `lifetime_purchased` → `premiumUntil = null` (grant indefinido, el mismo
   carril que la palanca admin de S4).
4. **Cancelación** — cancelar desde el portal → `subscription.updated` con
   `scheduled_change` (sigue premium hasta fin de periodo) → al vencer,
   `subscription.canceled` → cae a free por derivación.
5. **Impago** — forzar un pago fallido (tarjeta de fallo o simulador) →
   `payment_failed` → gracia corta (`PAYMENT_GRACE_DAYS`), luego free si no llega
   una activación que lo resuelva.

Alternativa sin pagos reales: Paddle → Developer tools → Simulations dispara
cada evento firmado contra el destino.

## Verificado hasta ahora (2026-08-25)

- **Firma del webhook**: round-trip real con el SDK 3.8.0 y el secreto de
  sandbox — acepta la firma válida, rechaza cuerpo alterado y secreto incorrecto.
- **Catálogo**: los tres price ids existen y están activos en sandbox —
  re-comprobado contra la API el 2026-08-25: mensual 4,99 €/mes, anual
  49 €/año, lifetime 99 € one-time, los tres `active`.
- **Checkout**: sigue bloqueado hasta fijar el Default Payment Link (paso 2);
  `transactions.create` responde `transaction_default_checkout_url_not_set` y el
  adapter degrada a null correctamente mientras tanto.
- **Client token**: creado por API (`ctkn_01m0x3sr1p9m7f1bkn68hwz26z`), en
  `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`.
- **Destino de notificaciones**: re-apuntado por API a
  `<túnel>/api/billing/webhook` y **activado** — apuntaba a `/webhooks/paddle`,
  una ruta que no existe en la app, y estaba `active=false`. Suscrito a los seis
  eventos de suscripción + `transaction.completed`.
- **Cabeceras servidas**: medidas contra el dev server. `/` lleva la política
  cerrada (`connect-src 'self'`, `payment=()`); `/premium/pagar` lleva la
  ensanchada, con UNA sola cabecera enforced en cada ruta — el lookahead no
  solapa.
- **Unit**: `paddle-adapter.test.ts` cubre checkout (ruta interna con el `_ptxn`,
  transacción sin id, `offersTier` sin llamar a la API, tier despublicado,
  fail-soft), portal, firma, mapeo de los cuatro eventos + casos borde y
  readSubscription. `pagar-view.test.ts` cubre las tres ramas de la ruta de pago
  y el rechazo de un `_ptxn` con forma inválida. `security-headers.test.ts` cubre
  la política ensanchada y su confinamiento. `billing.test.ts` cubre el guard de
  ordenación monótono. Suite de `apps/web`: 7230 verdes.

## Decisiones de producto (cerradas 2026-08-25, #1221)

- **Cancelación inmediata con reembolso conserva premium hasta fin de periodo:
  SE QUEDA ASÍ.** «Te quedas lo que pagaste». En la beta los reembolsos se
  tocan a mano, y si hiciera falta cortar el acceso está la palanca de revoke de
  /admin (S4, #1164). Revocar automáticamente al reembolsar exigiría manejar
  eventos `adjustment.*` y es un slice aparte, no abierto hoy.
  Detalle heredado de S5: `subscription_canceled` fija `premiumUntil` al
  `current_billing_period.ends_at` que informe Paddle, aunque haya reembolso. Es
  el comportamiento «te quedas lo que pagaste» para la cancelación normal a fin
  de periodo, pero con reembolsos reales significa dinero devuelto + acceso
  retenido — asumido a conciencia.
- **Downgrade inmediato con prorrateo** quedaría capado por el guard monótono
  (`premiumUntil` no se acorta en la activación). Paddle programa los downgrades
  a fin de periodo por defecto (`scheduled_change`), así que no se dispara hoy;
  documentado como asunción por si se habilita prorrateo inmediato.

## Pendiente (requiere dashboard de Jose)

**Un** clic, el único de todo esto que no tiene API:

- **Default payment link** = `https://fixed-sina-submundane.ngrok-free.dev/premium/pagar`
  en Paddle → Checkout → Checkout settings.

Con eso queda el paseo: medir la CSP real en el navegador con un checkout
abierto, y los cinco escenarios (tarjeta de test para las altas, simulador para
cancelación e impago), verificando entitlements y la convergencia del re-sync
de /admin. **Usar un workspace de prueba**: el control plane es Turso y un
paseo escribe entitlements de workspaces reales.
