# Opciones de cobro para un SaaS de suscripción desde España: Lemon Squeezy vs Paddle vs Stripe directo

- **Fecha de verificación:** 2026-07-18
- **Contexto:** fundador individual (autónomo) en España que vende una suscripción SaaS
  (~5 €/mes, con opción anual ~49 €) a consumidores particulares de la UE, mercado es-ES.
  Decisión: usar un *merchant of record* (MoR, que asume la venta y el IVA europeo) frente a
  cobrar directo con Stripe (sin MoR, liquidando uno mismo el IVA en régimen OSS).
- **Método:** solo fuentes primarias — páginas oficiales de pricing, docs oficiales, blog/changelog
  oficial y páginas oficiales de la Comisión Europea / AEAT para el IVA OSS. Los comparadores de
  terceros solo se usaron para *localizar* la afirmación primaria; cada afirmación cita la fuente
  que la posee. Lo que no pude confirmar en fuente primaria va en la sección final.
- **Cálculos de comisión:** los precios de referencia (4,99 € y 49 €) se tratan como importe
  cobrado **IVA incluido**, tal y como paga el consumidor. Para Stripe directo se asume tarjeta
  de consumidor del EEE (el caso más barato de su tarifa).

> **Titular que condiciona todo:** Lemon Squeezy fue **adquirida por Stripe en 2024** y hoy (jul-2026)
> está en **modo mantenimiento y migración**: su propio CEO reconoce un "capítulo más silencioso"
> con soporte más lento, y el producto estratégico pasa a ser **Stripe Managed Payments**, el nuevo
> MoR de Stripe construido por el equipo de Lemon Squeezy. Lemon Squeezy sigue operativo y aceptando
> altas (5 % + 50 ¢, sin tarjeta para registrarse), pero **no recomendaría construir algo nuevo
> encima de un producto cuyo dueño ya publica la ruta de salida**. Fuente:
> <https://www.lemonsqueezy.com/blog/2026-update> (JR Farr, 28-ene-2026).

---

## Resumen ejecutivo y recomendación

Para un fundador solo que cobra 5 €/mes a consumidores de la UE y quiere **el mínimo de burocracia
fiscal**, un **merchant of record vale la pena**: a cambio de una comisión alta (≈10-15 % en tickets
pequeños) el MoR se convierte en el vendedor legal y **liquida todo el IVA europeo por ti** en los
27 estados, emite las facturas con IVA y asume contracargos. Cobrar directo con Stripe es
**mucho más barato** (≈2-7 %), pero te obliga a **registrarte en el régimen OSS ante la AEAT y
presentar el modelo 369 trimestralmente** en cuanto superes los 10.000 € anuales de ventas
transfronterizas B2C en la UE — y **Stripe Tax calcula y cobra el IVA pero NO lo presenta ni te
registra** por ti.

Recomendación ordenada:

1. **Empieza con un MoR.** A 5 €/mes, el ahorro de no montar OSS + facturación con IVA de 27 países
   compensa de sobra la comisión durante toda la fase temprana.
2. **Entre los MoR, la elección hoy es Paddle vs Stripe Managed Payments:**
   - **Paddle** es el MoR maduro y sin asteriscos de ciclo de vida. Payouts en EUR **gratis por SEPA**,
     mínimo 100 €, mensual. **Aviso importante:** la tarifa estándar 5 % + 50 ¢ de Paddle **no aplica
     de forma automática a productos por debajo de 10 $** — su propia página de precios dice que para
     eso hay que "contactar para precio personalizado". A 4,99 € caes justo en ese tramo, así que
     confirma condiciones en el alta.
   - **Stripe Managed Payments** es la apuesta estratégica (y la más barata de los MoR: ≈10 % en el
     ticket mensual frente al ≈15 % de Paddle/Lemon Squeezy), con España soportada y SaaS elegible,
     pero está en **public preview desde feb-2026** (aún por lista de espera / acceso público
     inminente): madurez y estabilidad de contrato menores.
   - **Lemon Squeezy**: funcionalmente sirve y sigue abierto, pero está en migración hacia Managed
     Payments. Solo lo elegiría si ya tuvieras cuenta; para algo nuevo, no.
3. **Stripe directo (sin MoR)** solo si estás dispuesto a llevar tú el OSS. Es la opción que **más
   margen deja y en la que eres dueño de la relación con Stripe**, pero a cambio de trabajo fiscal
   recurrente. Es la evolución natural cuando el volumen justifique la comisión del MoR.
4. **En los tres casos**, gestiona la prueba gratuita **en tu propia app** (entitlement + `trial_ends_at`
   en tu DB de control) y manda al usuario al checkout solo al convertir: ninguno te obliga a pedir
   tarjeta durante el trial y todos crean la suscripción en el momento del checkout.

### Categoría (¿nos aceptan?)

Un **tracker de patrimonio personal sin asesoramiento, sin ejecución de órdenes y sin custodia/transmisión
de dinero** es, en los tres, un producto de **software/SaaS digital**, que es la categoría explícitamente
aceptada. El riesgo no es la naturaleza del producto sino la **adyacencia a lo financiero**: todos
prohíben o restringen los *servicios financieros regulados* y el *asesoramiento de inversión*. Conviene
describir el producto en el alta como "herramienta de software de seguimiento de patrimonio, sin
asesoramiento ni intermediación" para no caer en la casilla equivocada de la revisión.

---

## Tabla comparativa

| Eje | Lemon Squeezy (MoR) | Paddle (MoR) | Stripe Managed Payments (MoR) | Stripe directo (sin MoR) |
|---|---|---|---|---|
| Comisión titular | 5 % + 50 ¢ | 5 % + 50 ¢ (⚠ <10 $ = precio a medida) | 3,5 % **+** comisión Payments (1,5 % + 0,25 € EEE) ⇒ ≈5 % + 0,25 € | 1,5 % + 0,25 € (tarjeta EEE); +Billing 0,7 %; +Tax 0,5 % |
| Efectivo en 4,99 € | ≈15,0 % | ≈15,0 % | ≈10,0 % | ≈6,5 % (solo Payments) / ≈7,7 % (con Billing+Tax) |
| Efectivo en 49 € | ≈6,0 % | ≈6,0 % | ≈5,5 % | ≈2,0 % / ≈3,2 % |
| ¿Quién liquida el IVA UE? | **El MoR** (registrado para declarar y pagar) | **El MoR** | **El MoR** (IVA/GST en 80+ países) | **Tú**: alta OSS en AEAT + modelo 369 trimestral |
| Alta desde España | Sí, sin SL; sin tarjeta para registrarse | Sí; verificación KYC + revisión de dominio | Sí, España en la lista de países soportados | Sí (cuenta Stripe autónomo) |
| Payout | Transferencia/PayPal, 2×/mes, 200+ países | SEPA en EUR **gratis**; SWIFT 15 € si diverge; mín. 100 €, mensual | Payouts Stripe estándar | Payouts Stripe estándar |
| Trial sin tarjeta | Sí (trial en tu app, checkout al convertir) | Sí (íd.) | Sí (íd.) | Sí (íd.) |
| Webhooks entitlements | `subscription_*`, firma HMAC-SHA256, reintentos | `subscription.*`/`transaction.*`, `Paddle-Signature` HMAC+ts, reintentos | Webhooks Stripe (los más completos), firma + reintentos | Íd. Stripe |
| Estado del producto | En migración a Managed Payments | Maduro | Public preview (feb-2026) | GA |

Fórmulas: MoR/Paddle/LS = 5 %·P + 0,50 €. Stripe Managed = (3,5 %+1,5 %)·P + 0,25 €. Stripe directo =
1,5 %·P + 0,25 € (+1,2 % si sumas Billing 0,7 % y Tax 0,5 %). El fijo de Paddle/LS es nominalmente
**0,50 $** (se cobra en la divisa de la transacción); el de Stripe EEE es **0,25 €**.

---

## 1) Comisiones reales por transacción

### Lemon Squeezy — 5 % + 50 ¢, todo incluido
La página de precios declara **"5 % + 50¢ per transaction"** sin cuota mensual para ecommerce, con
nota de que "algunos pagos pueden estar sujetos a comisiones adicionales" (métodos de pago extra,
divisa, casos borde). Fuente: <https://www.lemonsqueezy.com/pricing>.
- 4,99 €: 5 %·4,99 + 0,50 = **0,75 € ⇒ 15,0 %**.
- 49 €: 5 %·49 + 0,50 = **2,95 € ⇒ 6,0 %**.

### Paddle — 5 % + 50 ¢, con asterisco de importe mínimo
La página de precios declara **"5% + 50¢ per Checkout transaction"** e incluye tax, fraude, recobro y
soporte sin add-ons. **Advertencia literal:** *"If you're selling products under $10 or require
invoicing contact us for custom pricing"*. Un ticket de 4,99 € cae en ese tramo, así que la tarifa
estándar puede no aplicarse tal cual. Fuente: <https://www.paddle.com/pricing>.
- Misma aritmética que Lemon Squeezy: **15,0 %** en 4,99 € y **6,0 %** en 49 € (si te dan la tarifa estándar).
- Extras: margen de conversión de divisa **hasta 1,5 %** si el payout va en divisa distinta a tu
  Balance Currency, y **15 $/€/£** de comisión SWIFT si el payout no coincide con la divisa local de
  tu banco (véase eje 3). Fuente:
  <https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts>.

### Stripe Managed Payments — 3,5 % SOBRE la tarifa de Payments
El pricing de Stripe (sitio ES) lista Managed Payments como **"3,5 %"** por transacción con éxito
**además** de las comisiones de Payments. Para tarjeta de consumidor del EEE, Payments es
**1,5 % + 0,25 €**, así que el total efectivo es **≈5 % + 0,25 €**. Fuente:
<https://stripe.com/es/pricing> (secciones Payments y Managed Payments).
- 4,99 €: 5 %·4,99 + 0,25 = **0,50 € ⇒ 10,0 %**.
- 49 €: 5 %·49 + 0,25 = **2,70 € ⇒ 5,5 %**.
- Es más barato que Paddle/LS en tickets pequeños porque el fijo es 0,25 € (no 0,50 €). Ojo: tarjetas
  premium (1,9 %) e internacionales (3,25 % + 2 % de conversión) suben el efectivo.

### Stripe directo (sin MoR) — la base más barata
Payments para tarjeta de consumidor del EEE: **1,5 % + 0,25 €**; tarjetas premium **1,9 % + 0,25 €**;
Reino Unido **2,5 % + 0,25 €**; internacionales **3,25 % + 0,25 € + 2 %** de conversión. Suscripciones
con Stripe Billing: **0,7 %** del volumen (pago por uso) o desde **500 €/mes** con contrato. Stripe Tax:
**0,5 %** (integración no-code) o **0,45 €**/transacción (API). Fuente: <https://stripe.com/es/pricing>.
- Solo Payments — 4,99 €: 1,5 %·4,99 + 0,25 = **0,32 € ⇒ 6,5 %**; 49 €: **0,99 € ⇒ 2,0 %**.
- Con Billing (0,7 %) + Tax (0,5 %) = +1,2 % — 4,99 €: **0,38 € ⇒ 7,7 %**; 49 €: **1,57 € ⇒ 3,2 %**.
- Puedes evitar Billing (llevando tú la lógica de suscripción) y Tax (calculando tú el IVA), quedándote
  en 1,5 % + 0,25 €, a cambio de más código y de asumir el cálculo del IVA.

---

## 2) IVA europeo: quién es el sujeto pasivo

**Con MoR (Lemon Squeezy / Paddle / Stripe Managed Payments):** el MoR es el **vendedor legal** ante el
consumidor y **asume íntegramente el IVA/GST**: lo calcula, lo cobra en el precio, lo declara y lo paga
en cada jurisdicción, y emite la factura con IVA. Tú no te registras en OSS.
- Lemon Squeezy: *"Lemon Squeezy is your merchant of record. We take on the liability of tax collection
  and calculation and pay taxes on your behalf"* — <https://www.lemonsqueezy.com/pricing>.
- Stripe Managed Payments: *"Managed Payments handles indirect tax compliance (sales tax, VAT, and GST)
  on transactions in more than 80 countries"* — <https://docs.stripe.com/payments/managed-payments>.

**Con Stripe directo (sin MoR):** el sujeto pasivo eres **tú**. Reglas UE:
- Existe un **umbral anual de 10.000 €** (sin IVA) para el conjunto de tus ventas transfronterizas B2C
  de servicios TBE (electrónicos) en la UE. **Por debajo**, el IVA se repercute con las reglas del país
  del proveedor (España, 21 %) y se declara en el modelo 303. **Por encima**, el IVA es el del país del
  **consumidor** y conviene usar OSS. Fuente (Comisión Europea): la Guide to the VAT OSS y las páginas de
  la ventanilla única — <https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en>.
- El régimen **OSS (Ventanilla Única / One Stop Shop)** permite **registrarse una sola vez** en el Estado
  de identificación (España), **declarar todas las ventas UE en una única autoliquidación trimestral**
  (**modelo 369**) y que la AEAT redistribuya el IVA a cada país. Períodos trimestrales, presentación
  hasta fin del mes siguiente. Fuentes:
  <https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en> y
  <https://sede.agenciatributaria.gob.es/Sede/iva/iva-comercio-electronico/presentacion-autoliquidaciones-periodicas-modelo-369.html>.

**Qué hace y qué NO hace Stripe Tax (clave):** Stripe Tax **calcula y cobra** el impuesto correcto, pero
**no te registra ni presenta las declaraciones**. La propia doc dice: *"You must file and remit the tax
you collect for every location where you're registered"*. Para presentar en la UE, Stripe se apoya en un
**partner de filing (Marosa)**, no lo hace el propio Stripe Tax. Fuente:
<https://docs.stripe.com/tax/filing>. Es decir: con Stripe directo, Stripe Tax te ahorra el cálculo,
pero el **alta en OSS y el modelo 369 trimestral siguen siendo tarea tuya** (o de tu gestoría / de Marosa).

---

## 3) Requisitos de alta desde España

**Lemon Squeezy:** alta como creador individual sin necesidad de SL; **no piden tarjeta para registrarse**
(*"Do I need a credit card to sign up? Nope"*). Payouts por **transferencia bancaria y PayPal**,
procesados **dos veces al mes**, con soporte en 200+ países. Fuente: <https://www.lemonsqueezy.com/pricing>.

**Paddle:** alta con verificación de cuenta (KYC) y **revisión del dominio/web** antes de poder vender
(Paddle exige una web con divulgación comercial y descripción del producto). Payouts:
- **Gratis** cuando la divisa del payout coincide con la divisa local del país de tu banco — p. ej.
  **EUR a un banco de la Eurozona vía SEPA**. Si divergen, **transferencia SWIFT con comisión de 15 $/€/£**.
- **Margen de conversión de hasta 1,5 %** si eliges cobrar en una divisa distinta a tu Balance Currency.
- **Umbral mínimo de payout 100 $ (≈100 €/£100)**, ajustable hasta 100.000 $. El payout se **crea el día 1**
  y se **envía antes del 15** (cadencia mensual); si no llegas al mínimo, se acumula al mes siguiente.
- Fuentes: <https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts> y
  <https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid>.

**Stripe Managed Payments:** **España (ES) está en la lista de países de vendedor soportados** (junto al
resto de la UE, UK, EEUU, etc.), y solo admite **integraciones directas** (no plataformas Connect /
cuentas Express). Fuente: <https://docs.stripe.com/payments/managed-payments/eligibility>.

**Stripe directo:** cuenta Stripe estándar como autónomo español; payouts SEPA a cuenta en EUR.

---

## 4) Trials sin tarjeta

Ninguna de las plataformas te **obliga** a pedir tarjeta durante una prueba gratuita, porque el patrón
recomendado para todas es el mismo y encaja con la arquitectura de worthline (entitlements en la DB de
control): **gestionar el trial en tu app** (guardar `plan`/`trial_ends_at`) y **enviar al usuario al
checkout solo cuando convierte**. La suscripción se crea en el momento del checkout — no hay fricción en
crear la suscripción "tarde".
- Lemon Squeezy soporta trials (con o sin tarjeta) y crea la suscripción al pagar; su checkout es
  hospedado, así que no tocas datos de tarjeta. Fuente: <https://www.lemonsqueezy.com/pricing> (FAQ de
  suscripciones) y docs de checkout.
- Paddle y Stripe Managed Payments crean la suscripción en el checkout hospedado del MoR; el trial
  app-side es totalmente compatible.
- Stripe directo: idéntico patrón; el trial de Stripe Billing puede además configurarse sin tarjeta,
  pero para tu caso lo más limpio es el trial app-side + checkout al convertir.

---

## 5) API y webhooks para entitlements

Los tres exponen webhooks de suscripción con verificación de firma y reintentos, y API para consultar el
estado — suficiente para sincronizar una tabla de entitlements externa.

- **Lemon Squeezy:** eventos de suscripción (`subscription_created`, `subscription_updated`,
  `subscription_payment_success`, `subscription_payment_failed`, `subscription_cancelled`, además de
  `order_*`), **firma HMAC-SHA256** con un *signing secret* por webhook, y reintentos. API REST para
  consultar suscripciones. Fuente: <https://docs.lemonsqueezy.com/help/webhooks> y
  <https://docs.lemonsqueezy.com/api>.
- **Paddle (Billing):** eventos `subscription.created` / `.activated` / `.updated` / `.canceled` /
  `.paused` / `.past_due` y `transaction.completed` / `transaction.payment_failed`; verificación con
  cabecera **`Paddle-Signature`** (HMAC-SHA256 + timestamp `ts` para prevenir *replay*), reintentos, y
  API para leer suscripciones. Fuentes: <https://developer.paddle.com/webhooks/overview> y
  <https://developer.paddle.com/webhooks/signature-verification>.
- **Stripe (directo o Managed Payments):** el catálogo de webhooks más completo
  (`customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`…), verificación de firma
  (`Stripe-Signature`) y reintentos robustos; API madura. En Managed Payments **las suscripciones
  requieren Stripe Billing**. Fuentes: <https://docs.stripe.com/webhooks> y
  <https://docs.stripe.com/payments/managed-payments>.

Para worthline (entitlements en la DB de control): el patrón en los tres es idéntico — recibir el webhook,
verificar firma, mapear `customer/subscription id` → workspace, y actualizar `plan`/`trial_ends_at`/estado.
Stripe es el que menos sorpresas dará por madurez del catálogo de eventos.

---

## 6) Restricciones de categoría (¿aceptan un tracker de patrimonio?)

El producto —seguimiento de patrimonio personal, **sin asesoramiento, sin ejecución de órdenes, sin
transmisión de dinero**— es **software/SaaS**, la categoría aceptada por defecto en los tres. El riesgo
está en la **adyacencia financiera**; conviene citar textualmente qué prohíben:

**Lemon Squeezy** — acepta explícitamente *"Software & SaaS"*. Su lista de prohibidos incluye *"Services
of any kind"* (pero SaaS es producto, no servicio) y, en regulados, *"Regulated services such as: …
banking/financing, currency exchange, warranties, etc."*. También **remite a la lista de negocios
restringidos de Stripe** como criterio de sus procesadores. Un tracker sin custodia ni asesoramiento no es
banca ni cambio de divisa. Fuente:
<https://docs.lemonsqueezy.com/help/getting-started/prohibited-products>.

**Paddle** — su Acceptable Use Policy prohíbe explícitamente *"Trading and financial services/advice"*,
*"Any product or service that is considered a regulated financial product or service in any jurisdiction"*,
*"Investment or financial advice, including trading signals and strategies"*, *"Business or investment
opportunities"* y *"Exchanges, dealers, or trading platforms…"*. **Un tracker que no da consejo ni ejecuta
operaciones no encaja en ninguna**, pero es la categoría donde Paddle hace *enhanced due diligence*:
descríbelo como herramienta de software sin asesoramiento. Fuente:
<https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle>.

**Stripe (Managed Payments y directo)** — para Managed Payments, elegible = *"Software, video games,
digital media, online courses, electronically supplied … web services"*; **excluidos** bienes físicos,
*"professional services (consulting, marketing, design, development, tech support)"* y eventos presenciales.
Un tracker SaaS es elegible. En la lista global de negocios restringidos, *"Productos y servicios
financieros"* figuran como **restringidos (disponibilidad limitada, contactar con Stripe)**, y también
como restringido *"contenido/herramientas sobre cómo obtener beneficios mediante el comercio o las
inversiones en productos financieros o criptomoneda"* — otra razón para dejar claro que **no ofreces
asesoramiento**. Fuentes: <https://docs.stripe.com/payments/managed-payments/eligibility> y
<https://stripe.com/legal/restricted-businesses>.

---

## 7) Otras diferencias operativas decisivas

- **Contracargos:** con MoR (los tres), el MoR asume la gestión y buena parte de la protección
  antifraude; Paddle documenta que retiene comisiones de contracargo/reembolso en el payout
  (<https://developer.paddle.com/changelog/2025/retained-fees-payout-totals>). Con Stripe directo,
  gestionas tú las disputas (Stripe Radar ayuda pero el riesgo es tuyo).
- **Reembolsos:** en modelos MoR, al reembolsar se devuelve el importe al cliente pero **la comisión del
  MoR no siempre se recupera** — verifícalo en el alta.
- **Facturas con IVA UE:** con MoR, el MoR emite la factura con IVA por ti; con Stripe directo, la
  facturación con IVA correcta por país es responsabilidad tuya (Stripe Invoicing/Tax ayuda al cálculo).
- **Divisa/EUR:** los tres soportan precios en EUR. En Stripe directo, tarjetas internacionales suman
  ~2 % de conversión; en Paddle, el margen de conversión de payout es de hasta 1,5 % y el SEPA en EUR es
  gratis.
- **Cambios de plan (upgrade/downgrade/pausa):** cubiertos por Stripe Billing y por el motor de
  suscripciones de Paddle/Lemon Squeezy; para worthline, mantén la lógica de tiers en la app y refleja el
  cambio vía webhook.

---

## Riesgos y cosas a verificar en el alta

1. **Lemon Squeezy en migración.** Confirmar si merece la pena arrancar en un producto que Stripe está
   fusionando en Managed Payments (soporte más lento admitido por su CEO; la entidad ya figura como
   *"Link, LLC f/k/a Lemon Squeezy LLC"*). Fuente: <https://www.lemonsqueezy.com/blog/2026-update>.
2. **Paddle y el mínimo de 10 $.** La tarifa 5 % + 50 ¢ **puede no aplicar a un producto de 4,99 €**
   (su web pide "custom pricing" por debajo de 10 $). Pedir por escrito la tarifa real para ese ticket.
3. **Stripe Managed Payments está en public preview.** Verificar acceso (lista de espera / acceso público),
   estabilidad del contrato y si tu caso de suscripción a 5 € entra sin fricción; confirmar que exige
   Stripe Billing para las suscripciones.
4. **Base de la comisión del MoR.** Comprobar si el 5 % se aplica sobre el importe **con IVA incluido** o
   sobre la base sin IVA — puede mover el efectivo ~0,5-1 punto respecto a los cálculos de aquí.
5. **Umbral OSS de 10.000 €** (solo Stripe directo). Mientras estés por debajo del umbral anual UE puedes
   repercutir IVA español y usar el modelo 303; al superarlo, alta en OSS y **modelo 369 trimestral**.
   Fuente: <https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en>.
6. **Stripe Tax no presenta.** Si vas por Stripe directo, presupuestar el alta en OSS y el filing
   (gestoría o partner Marosa); Stripe Tax solo calcula/cobra. Fuente: <https://docs.stripe.com/tax/filing>.
7. **Categoría "financiera" en la revisión.** En los tres, redactar la descripción del producto como
   "software de seguimiento de patrimonio, sin asesoramiento de inversión ni intermediación" para no caer
   en las casillas de *servicios financieros regulados* / *asesoramiento de inversión*.
8. **Contracargos y reembolsos:** confirmar en cada MoR si se recupera o no la comisión al reembolsar y
   qué comisión de contracargo se retiene.

---

### Índice de fuentes primarias
- Lemon Squeezy — 2026 Update (blog oficial): <https://www.lemonsqueezy.com/blog/2026-update>
- Lemon Squeezy — Pricing: <https://www.lemonsqueezy.com/pricing>
- Lemon Squeezy — Prohibited Products: <https://docs.lemonsqueezy.com/help/getting-started/prohibited-products>
- Lemon Squeezy — Webhooks / API: <https://docs.lemonsqueezy.com/help/webhooks> · <https://docs.lemonsqueezy.com/api>
- Paddle — Pricing: <https://www.paddle.com/pricing>
- Paddle — Acceptable Use Policy (help): <https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle>
- Paddle — Payout fees: <https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts>
- Paddle — When/how paid: <https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid>
- Paddle — Webhooks / firma: <https://developer.paddle.com/webhooks/overview> · <https://developer.paddle.com/webhooks/signature-verification>
- Stripe — Pricing (ES): <https://stripe.com/es/pricing>
- Stripe — Managed Payments: <https://stripe.com/managed-payments> · <https://docs.stripe.com/payments/managed-payments>
- Stripe — Managed Payments eligibility: <https://docs.stripe.com/payments/managed-payments/eligibility>
- Stripe — Restricted businesses: <https://stripe.com/legal/restricted-businesses>
- Stripe — Tax filing (qué hace y qué no): <https://docs.stripe.com/tax/filing>
- Stripe — Webhooks: <https://docs.stripe.com/webhooks>
- Comisión Europea — VAT One Stop Shop: <https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en> · <https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en>
- AEAT — Modelo 369 (OSS): <https://sede.agenciatributaria.gob.es/Sede/iva/iva-comercio-electronico/presentacion-autoliquidaciones-periodicas-modelo-369.html>

### Lo que no pude verificar en fuente primaria
- **Comisión exacta de Stripe Managed Payments para un ticket de 4,99 €** ni si el 3,5 % se aplica antes o
  después del IVA (la landing remite a "consultar tarifas"; la cifra 3,5 % + Payments viene del pricing ES).
- **Tarifa real de Paddle para productos < 10 $** (su web solo dice "contactar para precio personalizado").
- **Nombres exactos y payload de cada evento de webhook de Lemon Squeezy** (la doc está renderizada en
  cliente; los eventos listados provienen de la doc oficial pero no pude fijar el listado literal completo).
- **Si Lemon Squeezy sigue aceptando altas nuevas de forma indefinida**: hoy el alta está abierta, pero el
  blog oficial apunta a migración; no hay una fecha primaria de cierre de nuevas altas.
