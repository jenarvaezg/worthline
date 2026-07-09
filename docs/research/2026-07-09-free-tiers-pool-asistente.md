# Free tiers de proveedores LLM para el asistente financiero — pool de proveedores gratis

- **Fecha de verificación:** 2026-07-09
- **Ticket:** #838 · **Mapa:** #837 · **PRD:** #704
- **Contexto:** el asistente financiero de worthline usa hoy el free tier de Groq con
  `llama-3.3-70b-versatile` (techo observado: ~100k tokens/día, se agota). Buscamos un pool de
  proveedores gratis validados. Los tool outputs llevan **datos financieros reales del usuario**,
  así que los términos de retención/entrenamiento pesan tanto como las cuotas.
- **Método:** solo fuentes primarias (docs oficiales, páginas de pricing/rate-limits, términos de
  servicio y políticas de privacidad first-party). Las afirmaciones sin fuente primaria van
  marcadas y recogidas en la sección final "Lo que no pude verificar".

> Aviso de privacidad crítico: dos de los cuatro proveedores (**Gemini free tier** y **OpenRouter
> `:free`**) **usan los prompts/outputs para entrenar** en su modalidad gratis. Para datos
> financieros reales del usuario, hoy solo **Groq** y **Cerebras** ofrecen, en fuente primaria,
> términos de "no entrenamos / no retenemos".

---

## Tabla comparativa

| Proveedor         | Modelo apto (function calling)           | TPD (free)                                                 | TPM / RPM                                                | ¿Entrena con datos en free?                                                                         | Paquete AI SDK                |
| ----------------- | ---------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Groq**          | `llama-3.3-70b-versatile`                | **100.000**                                                | 12.000 TPM / 30 RPM (+1.000 RPD)                         | **No** (contrato prohíbe usar I/O para training; ZDR opcional)                                      | `@ai-sdk/groq`                |
| **Cerebras**      | `gpt-oss-120b`                           | **1.000.000**                                              | 30.000 TPM / **5 RPM** (+1M TPH)                         | **No** ("no retenemos inputs/outputs")                                                              | `@ai-sdk/cerebras`            |
| **Google Gemini** | `gemini-2.5-flash`                       | No publicado (per-cuenta en AI Studio; ~250 RPD reportado) | ~250K TPM / ~10 RPM (no publicado)                       | **Sí** + revisión humana                                                                            | `@ai-sdk/google`              |
| **OpenRouter**    | `meta-llama/llama-3.3-70b-instruct:free` | No hay tope de tokens; tope por requests                   | — / 20 RPM (**50 RPD** sin créditos, 1.000 RPD con ≥$10) | **Sí en la práctica** (los endpoints `:free` suelen exigir opt-in a logging/training del proveedor) | `@openrouter/ai-sdk-provider` |

**Lectura rápida para el pool:** el mejor complemento privacidad-limpio de Groq es **Cerebras**
(mismo veredicto de datos, 10× el tope diario de tokens, pero con un cuello de botella de 5 RPM).
Gemini y OpenRouter `:free` quedan **descartados para datos reales del usuario** por sus términos
de entrenamiento, salvo que se restrinjan a rutas de retención cero (OpenRouter ZDR) o se pague el
tier de Gemini.

---

## 1) Groq

**Veredicto:** cuotas verificadas coinciden con lo observado en el PRD (100k TPD). Términos de datos
**limpios** en fuente primaria: prohíbe usar inputs/outputs para entrenar y no retiene por defecto.

### a) Cuotas del free tier (verificado)

Para `llama-3.3-70b-versatile` en el plan Free:

- **RPM:** 30 · **RPD:** 1.000 · **TPM:** 12.000 · **TPD:** 100.000
- `llama-3.1-8b-instant` (Free): RPM 30 · RPD 14.400 · TPM 6.000 · TPD 500.000
- Los límites aplican **a nivel de organización**, no de usuario; se dispara el primero que se
  agote (requests o tokens).
- Fuente: <https://console.groq.com/docs/rate-limits> (acceso 2026-07-09).

El **TPD de 100.000 coincide exactamente con el techo observado en el PRD #704** — confirmado.

### b) Modelos aptos (verificado)

1. `llama-3.3-70b-versatile` — el que ya usamos; function calling fiable, es el 70B del free tier.
2. `llama-3.1-8b-instant` — fallback más rápido y con TPD mucho mayor (500k), menor calidad de
   razonamiento/tool-calling.

- Fuente: misma página de rate-limits (lista de modelos con su cuota por-modelo).

### c) Términos de datos (verificado — favorable)

El uso de GroqCloud NO se rige por la Privacy Policy general, sino por el **Groq Services
Agreement**, que dice:

- Groq **no está autorizado a usar Inputs u Outputs para entrenar o afinar** ningún modelo, salvo
  permiso/instrucción explícita del cliente. Cita: _"not permitted to use Inputs or Outputs for
  training or fine-tuning any AI Model Services or other models, unless explicitly granted
  permission or instructed by Customer."_
- Groq **no accede, usa, almacena ni retiene** Inputs/Outputs salvo lo necesario para prestar el
  servicio, cumplir la ley o verificar cumplimiento del AUP. Cita: _"does not access, use, store,
  or retain Inputs or Outputs except as necessary to provide the Cloud Services…"_
- Clientes elegibles pueden activar un **zero data retention setting**.
- El cliente **retiene la propiedad** de Inputs y Outputs.
- No se distingue free vs paid en estas cláusulas (aplica el mismo Services Agreement).
- Fuentes: <https://console.groq.com/docs/legal/services-agreement> y
  <https://groq.com/privacy-policy> (esta última confirma que las Cloud Services se rigen por el
  Services Agreement + DPA, no por la Privacy Policy). Acceso 2026-07-09.

> No verificado por fuente primaria: si el **zero data retention** está disponible en la cuenta
> free o solo para clientes enterprise ("eligible customers"). Asumir que el free tier tiene
> retención operativa mínima, no ZDR, salvo confirmación.

### d) Integración (verificado / parcial)

- Paquete AI SDK de Vercel: **`@ai-sdk/groq`**.
- Error 429: status `429 Too Many Requests` con **header `retry-after` en segundos**, más headers
  de requests/tokens restantes. Fuente: página de rate-limits.

### Tarjeta/teléfono y volatilidad

- No requiere tarjeta para el free tier (solo cuenta). No verificado en fuente primaria explícita
  en esta pasada; es el comportamiento actual del onboarding.

---

## 2) Cerebras Inference

**Veredicto:** el mejor complemento a Groq por privacidad **y** por tope diario (1M TPD = 10× Groq),
pero limitado por **5 RPM** y por una lista de modelos sin Llama 70B. El tier se llama "Free Trial"
(posible señal de que no es permanente).

### a) Cuotas del free tier (verificado)

Tabla "Free Trial", idéntica para los modelos free (valores para `gpt-oss-120b`):

- **RPM:** 5 · **TPM:** 30.000 · **TPH:** 1.000.000 · **TPD:** 1.000.000
- RPH/RPD no se listan por separado en la tabla.
- Límites a nivel de organización, varían por modelo.
- Fuente: <https://inference-docs.cerebras.ai/support/rate-limits> (acceso 2026-07-09).

El cuello de botella real aquí es **5 RPM** (no el token budget): un asistente con tool-calling
multi-paso puede encadenar varias llamadas por turno y toparse con RPM antes que con TPD.

### b) Modelos aptos (verificado — sin Llama 70B)

- Producción: **`gpt-oss-120b`** (OpenAI GPT-OSS 120B) — el candidato fuerte para tool-calling.
- Preview: `gemma-4-31b`, `zai-glm-4.7`.
- **Llama 3.3 70B NO está disponible** en los endpoints públicos de Cerebras.
- Fuente: <https://inference-docs.cerebras.ai/models/overview> (acceso 2026-07-09).

> No verificado por fuente primaria en esta pasada: fiabilidad de function calling de `gpt-oss-120b`
> en la práctica (la doc de modelos no detalla soporte de tools por modelo). Requiere una prueba de
> humo antes de meterlo en el pool. `gpt-oss-120b` soporta tool-calling por diseño del modelo, pero
> conviene validarlo contra el endpoint de Cerebras.

### c) Términos de datos (verificado — favorable)

- Cita: _"We do not retain inputs and outputs associated with our training, inference and chatbot
  Services."_
- Los logs de servicio se borran _"when they are no longer necessary to provide services to you."_
- **No hay distinción free vs paid** en la política respecto a retención/entrenamiento.
- Caveat de rol: la política no cubre el procesamiento como "data processor" en nombre de clientes;
  ahí rige el acuerdo del cliente.
- Fuente: <https://www.cerebras.ai/privacy-policy> (acceso 2026-07-09).

### d) Integración (verificado / parcial)

- Paquete AI SDK de Vercel: **`@ai-sdk/cerebras`**.
- Error 429: `429 Too Many Requests`. El **formato exacto (retry-after / mensaje) no está detallado**
  en la doc de rate-limits — no verificado.

### Tarjeta/teléfono y volatilidad

- Se accede con cuenta; históricamente sin tarjeta para el tier gratis (no verificado en fuente
  primaria en esta pasada).
- **Señal de volatilidad:** el tier se etiqueta "Free Trial" y la lista de modelos es corta y en
  rotación (varios en "preview"). Tratar las cuotas y el catálogo como cambiantes.

---

## 3) Google Gemini (AI Studio / Gemini API free tier)

**Veredicto:** **DESCARTADO para datos financieros reales del usuario.** El free tier entrena con los
datos y hay **revisión humana**; además, las cuotas ya no se publican de forma estable (se movieron a
AI Studio per-cuenta) y hay señales de recortes recientes.

### a) Cuotas del free tier (parcialmente verificado — ya NO publicadas en tabla estática)

- La página oficial de rate-limits **ya no lista números** por modelo: _"Rate limits depend on a
  variety of factors (such as your usage tier) and can be viewed in Google AI Studio."_ Remite a
  <https://aistudio.google.com/rate-limit> (per-cuenta, requiere login).
  Fuente: <https://ai.google.dev/gemini-api/docs/rate-limits> (acceso 2026-07-09).
- Valores comunitariamente reportados (NO fuente primaria, ver sección final): `gemini-2.5-flash`
  free ≈ **10 RPM / 250K TPM / 250 RPD**, con reportes de recorte de RPD a finales de 2025.

### b) Modelos aptos (verificado)

- **`gemini-2.5-flash`** — free, con function calling. Candidato principal.
- **`gemini-2.5-flash-lite`** — free, más barato/rápido, menor capacidad.
- `gemini-2.5-pro` — **solo de pago**.
- `gemini-2.0-flash` — free pero **deprecado** (apagado 2026-06-01 según la propia tabla; ya pasó).
- La tabla de pricing marca para los free: _"Content used to improve our products: Yes"_.
- Fuente: <https://ai.google.dev/gemini-api/docs/pricing> (acceso 2026-07-09).

### c) Términos de datos (verificado — DESFAVORABLE en free)

Los "Unpaid Services" (free tier):

- _"Google uses the content you submit to the Services and any generated responses to provide,
  improve, and develop Google products and services and machine learning technologies."_
- **Revisión humana:** _"Human reviewers may read, annotate, and process your API input and output."_
- Advertencia explícita: _"Do not submit sensitive, confidential, or personal information to the
  Unpaid Services."_
- "Paid Services": _"Google doesn't use your prompts … or responses to improve our products."_
- Fuente: <https://ai.google.dev/gemini-api/terms> (acceso 2026-07-09).

El caso de uso de worthline (tool outputs con patrimonio real del usuario) choca frontalmente con la
advertencia de Google. **No usar el free tier de Gemini para prompts que contengan datos del
usuario.** Solo sería viable el tier de pago (que sí excluye training).

### d) Integración (verificado / parcial)

- Paquete AI SDK de Vercel: **`@ai-sdk/google`**.
- Error 429: `429 RESOURCE_EXHAUSTED`. El formato de reintento (RetryInfo / retry delay) no fue
  verificado en fuente primaria en esta pasada.

### Tarjeta/teléfono y volatilidad

- Free tier accesible con cuenta Google, sin tarjeta.
- **Alta volatilidad:** las cuotas dejaron de publicarse en la doc y hay señales de recortes
  recientes (foros oficiales reportan bajadas de RPD). No fiable para planificar capacidad.

---

## 4) OpenRouter (modelos `:free`)

**Veredicto:** **DESCARTADO por defecto para datos reales del usuario.** OpenRouter en sí no entrena
ni loguea por defecto, **pero los endpoints `:free` casi siempre exigen habilitar logging/training
del proveedor downstream** para poder usarlos. Además el tope de **50 RPD sin créditos** es muy
restrictivo para un asistente.

### a) Cuotas de los `:free` (verificado)

- **RPM:** 20 (máximo para variantes `:free`).
- **RPD:** **50/día sin créditos comprados**; **1.000/día si se han comprado ≥$10 en créditos**
  (histórico, una sola vez).
- La capacidad se gobierna **globalmente**: crear cuentas/keys extra no sube los límites.
- Cloudflare puede bloquear tráfico anómalo; saldo negativo → `402 Payment Required`.
- No hay tope de tokens documentado para `:free`; el cuello de botella es requests/día.
- Fuente: <https://openrouter.ai/docs/api-reference/limits> (acceso 2026-07-09).

El límite de **50 RPD** hace inviable un asistente de uso continuado salvo que se metan $10 de
créditos (con lo que deja de ser estrictamente "gratis").

### b) Modelos aptos (parcialmente verificado — roster volátil)

- Convención verificada: los free llevan sufijo **`:free`** en el id. Fuente: docs de limits.
- Candidatos con tool-calling reportados (NO confirmados en la página live de modelos en esta
  pasada — la página es JS y no se pudo scrapear):
  - `meta-llama/llama-3.3-70b-instruct:free` (paridad con el modelo actual de Groq)
  - `qwen/qwen3-235b-a22b:free` (marcado con capacidad de tools)
- **El catálogo `:free` rota con frecuencia** (proveedores entran y salen). Verificar contra
  <https://openrouter.ai/models?max_price=0> antes de fijar ids.

### c) Términos de datos (verificado — DESFAVORABLE en la práctica para `:free`)

- OpenRouter **por sí mismo no entrena** y **no loguea prompts por defecto**.
- Pero: _"some models may store or train on your Inputs … and may allow you to opt-out … as
  described in their Model Terms."_ El training/retención lo gobierna el **proveedor downstream**.
- Muchos endpoints `:free` **requieren** activar el ajuste que permite enrutar a proveedores que
  entrenan con tus datos; sin ello aparece el error _"No endpoints found matching your data
  policy."_ (comportamiento documentado en guías; ver sección final).
- Si activas prompt logging, concedes a OpenRouter licencia amplia sobre el contenido e incluso
  permiso para _"license or sell your User Content in anonymized form."_
- Existe ajuste **Zero Data Retention (ZDR)**: enruta solo a endpoints cuyo proveedor no almacena
  ni entrena. Ajustes separados para free vs paid.
- Fuentes: <https://openrouter.ai/docs/features/privacy-and-logging>,
  <https://openrouter.ai/terms>, <https://openrouter.ai/docs/guides/privacy/provider-logging>
  (acceso 2026-07-09).

Para worthline: usar `:free` con datos reales implicaría, en la mayoría de casos, aceptar que el
proveedor entrene con ellos. Solo aceptable si se restringe estrictamente a rutas ZDR (y aun así
suele excluir a los `:free` más golosos).

### d) Integración (verificado / parcial)

- Paquete AI SDK: **`@openrouter/ai-sdk-provider`** (provider comunitario oficial de OpenRouter para
  el Vercel AI SDK).
- Error 429: HTTP estándar `429`; el formato específico para `:free` (retry-after) no está detallado
  en la doc — no verificado.

### Tarjeta/teléfono y volatilidad

- Cuenta gratis sin tarjeta para 50 RPD. Subir a 1.000 RPD exige compra de créditos (≥$10).
- Roster de modelos `:free` **muy volátil**.

---

## Lo que no pude verificar (sin fuente primaria en esta pasada)

- **Gemini — cuotas exactas del free tier.** Google retiró los números de la doc pública y los
  expone per-cuenta en AI Studio (login). Los valores `10 RPM / 250K TPM / 250 RPD` para
  `gemini-2.5-flash` provienen de reportes de terceros y foros oficiales de usuarios, con señales de
  recorte a finales de 2025. Tratar como estimación, no como cifra confirmada.
  (Refs terceros: foro oficial <https://discuss.ai.google.dev/> — hilos de free tier RPD).
- **OpenRouter — roster `:free` con tool-calling.** La página live de modelos es JS y no se pudo
  extraer; los ids `meta-llama/llama-3.3-70b-instruct:free` y `qwen/qwen3-235b-a22b:free` vienen de
  agregadores de terceros (costgoat, teamday, buldrr). Verificar en la página oficial de modelos
  antes de usarlos.
- **OpenRouter — mecánica exacta del error de data policy.** El mensaje _"No endpoints found matching
  your data policy"_ y la necesidad de opt-in a training para `:free` están documentados en guías de
  integración de terceros; la doc oficial confirma la existencia de los toggles free/paid y ZDR pero
  no describe literalmente ese flujo de error.
- **Groq / Cerebras — requisito de tarjeta y disponibilidad de ZDR en free.** No hallé una cláusula
  primaria explícita en esta pasada; el ZDR de Groq se menciona para "eligible customers" (posible
  gating enterprise).
- **Cerebras — soporte de function calling de `gpt-oss-120b` en su endpoint.** La doc de modelos no
  lo detalla; requiere prueba de humo.
- **Formatos de 429 con retry-after** de Cerebras, Gemini y OpenRouter no están documentados de forma
  explícita en las páginas consultadas (solo Groq confirma `retry-after` en segundos).
