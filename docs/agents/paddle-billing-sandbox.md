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
2. **Default Payment Link** (REQUERIDO, paso de dashboard, SIN API): Paddle →
   Checkout → Checkout settings → Default payment link. Sin él,
   `transactions.create` falla con `transaction_default_checkout_url_not_set` y
   `checkoutUrl` degrada a null (verificado 2026-07-23, y de nuevo 2026-08-25).
   **Es un requisito de cuenta para poder crear transacciones, no el destino de
   nuestro enlace de compra** (ver la sección siguiente): en sandbox vale
   `https://localhost/`.
3. **Hosted Checkout** (paso de dashboard, #1221): Paddle → Checkout → Hosted
   checkouts → crear uno para el producto. Da una URL
   `https://pay.paddle.io/checkout/hsc_…` que va a
   `WORTHLINE_PADDLE_HOSTED_CHECKOUT_URL`. **Ese** es el destino de los enlaces
   de `/premium`.
4. **Destino de notificaciones**: Paddle → Developer tools → Notifications →
   New destination (type Webhook) apuntando a `<túnel>/api/billing/webhook`.
   Eventos suscritos: `subscription.activated`, `subscription.updated`,
   `subscription.canceled`, `transaction.completed`. El secreto de ESE destino
   es `WORTHLINE_PADDLE_WEBHOOK_SECRET` (ya en `.local`, ntfset
   `ntfset_01ky5hmdsgjvr5r4d4c5kvd6pr`). Este paso **sí tiene API**:
   `paddle.notificationSettings.create({...})` devuelve el destino con su
   secreto, así que un túnel nuevo se cablea sin abrir el dashboard.
5. **Túnel**: `ngrok http 3000` (o `cloudflared`); usa la URL https como destino.

## Dónde vive el checkout (la trampa de Paddle, #1221)

Paddle Billing **no tiene un checkout hospedado por defecto al que enlazar**. La
`checkout.url` que devuelve `transactions.create` es el *default payment link*
de la cuenta —una página **tuya** que carga Paddle.js— con `?_ptxn=<txn>`
añadido. Con `https://localhost/` de default payment link, esa URL no abre nada.

Hay dos salidas y worthline eligió la primera (2026-08-25):

1. **Hosted Checkout de Paddle** (elegida): una página de pago que aloja Paddle,
   creada en el dashboard, a la que se le pasa la transacción ya creada por
   `?transaction_id=<txn>`. Preserva el «cero UI de facturación propia» del
   contrato #1135 y no toca la CSP. El adapter la usa cuando
   `WORTHLINE_PADDLE_HOSTED_CHECKOUT_URL` está configurada, y cae al
   `checkout.url` de la API cuando no.
2. **Página propia con Paddle.js** (descartada): meter un client token público
   y un script de terceros, y reabrir la CSP (`script-src`/`frame-src`/
   `connect-src` de Paddle) que #1256 acaba de cerrar.

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
- **Unit**: `paddle-adapter.test.ts` (26) cubre checkout —incluido el enlace al
  Hosted Checkout, la query preservada, la URL no parseable y el fallback al
  `checkout.url`—, portal, firma, mapeo de los cuatro eventos + casos borde, y
  readSubscription. `billing.test.ts` cubre el guard de ordenación monótono.

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

Solo dos clics que no tienen API, y luego el paseo:

1. **Default payment link** = `https://localhost/` (Checkout → Checkout
   settings). Desbloquea `transactions.create`.
2. **Hosted checkout** creado (Checkout → Hosted checkouts) y su URL en
   `WORTHLINE_PADDLE_HOSTED_CHECKOUT_URL` de `apps/web/.env.local`.

Con eso, el paseo (túnel + destino por API + los cinco escenarios, con el
simulador para cancelación e impago y tarjeta de test para las altas) ya no
necesita dashboard.
