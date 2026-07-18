# Mínimo legal para cobrar por worthline: fundador autónomo en España vendiendo un SaaS a consumidores de la UE vía *merchant of record*

- **Fecha de verificación:** 2026-07-18
- **Contexto:** fundador individual (**autónomo**) en España que cobra por worthline —un
  *tracker* de patrimonio/cartera personal, mercado es-ES— en modelo **freemium + suscripción
  premium + compra única «lifetime»**. La venta se cursa a través de un **merchant of record**
  (candidatos: **Paddle** o **Stripe Managed Payments**): el MoR es el **vendedor legal**
  (*vendedor de registro*) frente al consumidor y liquida el IVA europeo; el fundador es el
  **proveedor/suministrador** del software. Ver la investigación hermana
  [`2026-07-18-merchant-of-record-espana.md`](./2026-07-18-merchant-of-record-espana.md).
- **Rasgos del producto que condicionan lo legal:** **no** hay asesoramiento de inversión
  (ADR 0045: la IA es un asistente, no un asesor), **no** hay custodia de fondos, **no** hay
  agregación bancaria ni ejecución de órdenes. La app ya tiene **borrado total (reset)** y
  **exportación**. Datos tratados por: Vercel (hosting), Turso (BD), WorkOS (auth), Resend
  (email transaccional), Sentry (errores, previsto) y proveedores LLM del asistente
  (Google Gemini, Cerebras, Groq vía Vercel AI Gateway). **Sin analítica ni telemetría**
  (postura deliberada: solo facturación/entitlements + marcas de tiempo de *onboarding* y
  primer holding).
- **Método:** fuentes primarias — AEPD, BOE/EUR-Lex (RGPD, LOPDGDD, LSSI-CE, TRLGDCU), CNMV,
  Comisión Europea y docs oficiales de Paddle / Stripe / cada encargado del tratamiento. Los
  comentarios de terceros solo se usaron para *localizar* la fuente primaria; cada afirmación
  cita la que la posee. Lo no confirmable en fuente primaria va en la sección final.
- **Aviso:** esto es **investigación, no asesoramiento jurídico**. Antes de publicar textos
  legales o darse de alta, conviene una revisión de la gestoría/abogado. Repo público:
  investigación genérica, sin cifras internas.

---

## Resumen ejecutivo

Para un autónomo que vende un SaaS a consumidores de la UE **a través de un MoR**, el mínimo legal
es sorprendentemente corto porque **el MoR absorbe casi toda la parte fiscal y de facturación**
(IVA europeo, facturas al consumidor, contracargos). Lo que **sigue siendo tuyo** es la capa de
**información y datos del propio servicio**: un **aviso legal** con tu identidad de autónomo, unos
**términos de servicio** del software, una **política de privacidad RGPD** honesta (incluida la
cesión de contexto financiero a los LLM), y un **disclaimer de no-asesoramiento** que mantenga a
worthline fuera del perímetro de la CNMV.

Lo que **NO** necesitas a esta escala (con su fuente en la sección 8): **DPO**, **inscripción de
ficheros ante la AEPD** (no existe desde 2018), **banner de cookies** (si de verdad no hay
analítica), **licencia/registro CNMV**, **alta en OSS ni modelo 369** (lo hace el MoR), y **no
necesitas SL**: el autónomo basta.

Las cuatro cosas que **sí** hay que escribir/publicar (checklist abajo):
1. **Aviso legal** (LSSI-CE art. 10): nombre, NIF, domicilio/contacto. El Registro Mercantil **no**
   aplica a un autónomo no inscrito.
2. **Términos de servicio** del software (el MoR es vendedor de registro para el pago; tus ToS rigen
   el servicio), con la cláusula de *wind-down* honesto del *lifetime* y las salvedades de *beta*.
3. **Política de privacidad** RGPD+LOPDGDD: bases jurídicas, lista de encargados con DPA/SCC,
   transferencias a EE. UU. (DPF/SCC), derechos (ya cubiertos por reset+export) y **la cesión de
   contexto financiero a los proveedores LLM** (ninguno entrena con datos de API por defecto).
4. **Disclaimer de no-asesoramiento** visible en el asistente y en los ToS.

Y **dos configuraciones**: (a) publicar una **política de reembolsos** que el MoR exige al vendedor;
(b) confirmar con la gestoría el **reverse charge** de tus facturas al MoR.

---

## Checklist accionable

| # | Acción | Dónde | ¿Obligatorio? |
|---|--------|-------|---------------|
| 1 | Publicar **aviso legal**: nombre, **NIF**, domicilio o email de contacto directo y efectivo | Pie/`/legal/aviso-legal` | **Sí** (LSSI art. 10) |
| 2 | Publicar **términos de servicio** del software + cláusula *wind-down lifetime* + salvedad *beta* + no-asesoramiento | `/legal/terminos` | **Sí** (buena praxis + exige el MoR) |
| 3 | Publicar **política de privacidad** RGPD (bases, encargados, transferencias, derechos, **LLM**) | `/legal/privacidad` | **Sí** (RGPD arts. 13-14) |
| 4 | Publicar **política de reembolsos** (el MoR la exige al vendedor) | `/legal/reembolsos` o dentro de ToS | **Sí** (requisito del MoR) |
| 5 | Añadir **disclaimer de no-asesoramiento** en el asistente y checkout | UI del chat + ToS | **Sí** (mantiene fuera de CNMV) |
| 6 | Mantener un **Registro de Actividades de Tratamiento (RAT)** interno | Documento interno (no se presenta) | **Sí** pero **interno** (art. 30) |
| 7 | Firmar/aceptar el **DPA** de cada encargado (Vercel, Turso, WorkOS, Resend, Sentry, LLM) | Panel de cada proveedor | **Sí** (art. 28 RGPD) |
| 8 | Tener un **procedimiento de brecha 72 h** (a quién avisar, plantilla) | Runbook interno | **Sí** (art. 33-34) |
| 9 | **Reverse charge** en las facturas al MoR + alta en ROI/VIES si el MoR es de la UE | Gestoría (modelo 036/349) | **Sí** (a nivel gestoría) |
| — | Banner de cookies | — | **NO** si solo cookies técnicas |
| — | DPO, inscripción AEPD, licencia CNMV, OSS/modelo 369, SL | — | **NO** a esta escala |

---

## 1) Aviso legal (LSSI-CE)

**Qué obliga.** worthline es un «prestador de servicios de la sociedad de la información» (una web
que presta un servicio online a cambio de precio), así que le aplica el **art. 10 de la Ley 34/2002
(LSSI-CE)**. El prestador debe poner a disposición «**permanente, fácil, directa y gratuita**» por
medios electrónicos:

- **a)** «Su nombre o denominación social; su residencia o domicilio o, en su defecto, la dirección
  de uno de sus establecimientos permanentes en España» y datos de contacto que permitan
  «comunicación directa y efectiva» (p. ej., email).
- **b)** «Los datos de su inscripción en el **Registro Mercantil** en el que, **en su caso**, se
  encuentren inscritos» — el «**en su caso**» es la clave: un **autónomo no inscrito** en el Registro
  Mercantil **no** tiene que aportar este dato.
- **c)** «El **número de identificación fiscal** que le corresponda» (tu **NIF**).
- **d)** Si hay precios, «información **clara y exacta**… indicando si incluye o no los impuestos
  aplicables».

Fuente: BOE, Ley 34/2002, art. 10 — <https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758>.

**¿Cambia algo por vender vía MoR?** No para el aviso legal. La LSSI obliga al **prestador del
servicio de la sociedad de la información** (worthline/tú), con independencia de quién sea el
**vendedor legal del cobro** (el MoR). El MoR resuelve el IVA y la factura del pago; **el aviso legal
sigue siendo tuyo** porque tú operas la web y prestas el servicio.

**Mínimo a publicar:** nombre y apellidos, NIF, un medio de contacto directo (email basta como
«comunicación directa y efectiva»; el domicilio postal completo no es imprescindible si das un canal
efectivo, aunque muchos autónomos ponen «domicilio a efectos de notificaciones» por prudencia), y
mención de que los cobros los gestiona el MoR como vendedor. Además, cualquier **comunicación
comercial** por email debe ser «claramente identificable como tal» y con el emisor identificable
(art. 20-21 LSSI) — relevante solo si algún día mandas *marketing*, no para el email transaccional.

---

## 2) Términos de servicio

No hay una norma que fije «las cláusulas mínimas de un ToS de SaaS», pero sí un reparto de papeles
claro: **el MoR es el vendedor de registro del pago** (su *checkout*, sus condiciones de compra y su
factura con IVA rigen la transacción económica), mientras que **tus ToS rigen el uso del software**.
Conviene que los ToS enlacen a las condiciones del MoR para el pago y no las contradigan.

**Cláusulas mínimas recomendadas:**

- **Objeto y descripción** del servicio (tracker de patrimonio; qué hace y qué **no** hace: no
  custodia, no ejecuta órdenes, no asesora).
- **Cuentas y elegibilidad** (mayor de edad, datos veraces).
- **Planes**: freemium, premium (suscripción) y **lifetime** (compra única), con remisión a que el
  **cobro, la facturación con IVA y los reembolsos los gestiona el MoR** como vendedor legal.
- **Cláusula de *wind-down* honesto del *lifetime*** (compromiso explícito): «El plan *lifetime* da
  acceso a las funciones premium **mientras el servicio siga alojado y operativo**. Si worthline
  cesara, se avisará con antelación razonable, se mantendrá disponible la **exportación de datos** y,
  **a petición**, se **reembolsará** de forma proporcional/razonable la compra *lifetime*.» Esta
  redacción convierte tu compromiso moral en obligación contractual y encaja con el derecho de
  desistimiento y con las políticas de reembolso del MoR.
- **Salvedades de *beta*** («el servicio puede contener funciones en pruebas; pueden cambiar o
  retirarse; se presta "tal cual" dentro de los límites legales»). Ojo: frente a **consumidores** no
  se pueden excluir las garantías legales imperativas (TRLGDCU) ni la responsabilidad por dolo o
  negligencia grave; la salvedad *beta* limita expectativas, no elimina derechos del consumidor.
- **Cancelación y efectos** (cómo se cancela; qué pasa con los datos; el reset/export ya existen).
- **Propiedad intelectual**, **conducta aceptable**, **modificaciones del servicio y de los
  términos** (con preaviso), **limitación de responsabilidad** (dentro de lo permitido frente a
  consumidor), **ley aplicable y fuero** (España; para consumidores, el fuero imperativo es el del
  domicilio del consumidor).
- **Disclaimer de no-asesoramiento** (ver sección 6) y enlace a **privacidad** y **reembolsos**.

Nota de derecho de consumo: al dirigirte a **consumidores**, las cláusulas se leen bajo el
**TRLGDCU** (Real Decreto Legislativo 1/2007) y no valen las cláusulas «abusivas»
(p. ej., exención total de responsabilidad). Redacta en lenguaje claro (art. 80 TRLGDCU).

---

## 3) Privacidad (RGPD + LOPDGDD)

**Bases jurídicas (art. 6 RGPD).** Para casi todo el tratamiento de worthline la base es la
**ejecución del contrato** (art. 6.1.b): sin tratar los holdings del usuario no puedes prestarle el
servicio que ha contratado. Para **seguridad y corrección de errores** (Sentry) y **prevención de
fraude/abuso** cabe el **interés legítimo** (art. 6.1.f). Al **no** haber analítica ni marketing,
**no necesitas consentimiento** como base para nada del núcleo. La facturación/entitlements se apoya
en contrato + obligación legal contable.

**Dato importante — no es «categoría especial».** El **patrimonio y los datos financieros** del
usuario son datos personales, pero **no** son «categorías especiales» del **art. 9 RGPD** (que cubre
salud, biometría, ideología, religión, etc.). Por tanto **no** se activa el régimen reforzado del
art. 9 ni, por esa vía, la obligación de DPO. Son datos personales «normales» que exigen diligencia,
no el régimen especial.

**Lista de encargados del tratamiento (art. 28) y sus DPA.** Hay que **firmar/aceptar el DPA de cada
uno** y listarlos en la política de privacidad:

| Proveedor | Rol | DPA / mecanismo | Fuente |
|-----------|-----|-----------------|--------|
| **Vercel** (EE. UU.) | Hosting/ejecución | DPA con **SCC de la UE** + Addendum UK; exige due diligence a subencargados | <https://vercel.com/legal/dpa> |
| **Turso** (EE. UU.) | Base de datos | DPA incorporable desde la cuenta (sección «Documents») | <https://turso.tech/privacy-policy> · <https://trust.turso.tech/faq> |
| **WorkOS** (EE. UU.) | Autenticación | DPA con subencargados y preaviso de 14 días para objetar | <https://workos.com/legal/data-processing-addendum> |
| **Resend** (EE. UU.) | Email transaccional | DPA publicado; GDPR-compliant | <https://resend.com/legal/dpa> |
| **Sentry** (EE. UU.) | Errores (previsto) | DPA 5.1.0 con **SCC** (Módulos 2 y 3) y **DPF** como mecanismo, SCC de respaldo | <https://sentry.io/legal/dpa/> |
| **Google Gemini API** | LLM del asistente | Términos de API de pago: **no** entrena con tus datos (ver abajo) | <https://ai.google.dev/gemini-api/docs/logs-policy> |
| **Groq** | LLM del asistente | **No** entrena; sin retención por defecto; opción ZDR | <https://console.groq.com/docs/your-data> |
| **Cerebras** | LLM del asistente | **No** retiene ni entrena con inputs/outputs | <https://www.cerebras.ai/privacy-policy> · <https://support.cerebras.net/articles/1811589793-does-cerebras-retain-my-data> |

**Transferencias internacionales (EE. UU.).** Todos los de arriba son proveedores de EE. UU. El
marco vigente es el **EU-US Data Privacy Framework** (decisión de adecuación de la Comisión de julio
de 2023): si el proveedor está **certificado DPF**, la transferencia está cubierta por adecuación; si
no, o como respaldo, se usan las **Cláusulas Contractuales Tipo (SCC)** incluidas en su DPA. Sentry,
por ejemplo, declara explícitamente SCC como respaldo si el DPF decayera. **Acción:** firmar cada
DPA (que activa las SCC) y, en la política de privacidad, decir que las transferencias a EE. UU. se
amparan en **DPF y/o SCC**. Fuente del marco: Comisión Europea, adecuación EE. UU. (DPF) —
<https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/eu-us-data-transfers_en>.

**Los LLM y el contexto financiero — qué debe decir la privacidad.** worthline envía **contexto
financiero del usuario** (patrimonio, holdings) a los proveedores LLM para que el asistente responda.
La política de privacidad **debe**: (i) nombrar a los proveedores LLM como encargados; (ii) explicar
**qué** se envía y **para qué** (responder consultas del asistente); (iii) afirmar que **ninguno
entrena con esos datos por defecto** y que puedes ejercer supresión. Verificado en fuente primaria:

- **Google Gemini API (de pago):** en el nivel de pago, Google **no usa** tus *prompts* ni respuestas
  para mejorar sus productos (lo que incluye entrenamiento); además, para usuarios del **EEE/Suiza/UK**
  las condiciones de pago aplican también a los niveles no de pago. Fuente:
  <https://ai.google.dev/gemini-api/docs/logs-policy>. (Evita el AI Studio gratuito, que **sí** puede
  usar el contenido.)
- **Groq:** «no está permitido usar inputs u outputs para entrenar o afinar modelos» salvo permiso
  del cliente; **sin retención por defecto** (logs temporales de hasta 30 días solo para depurar/abuso)
  y opción **Zero Data Retention**. Fuente: <https://console.groq.com/docs/your-data>.
- **Cerebras:** **no retiene** inputs/outputs de inferencia y **no entrena** con datos de usuario.
  Fuente: <https://support.cerebras.net/articles/1811589793-does-cerebras-retain-my-data>.

**Derechos de los interesados (arts. 15-20).** Ya cubiertos por el producto: **acceso/portabilidad**
= la **exportación** existente (formato legible), **supresión** = el **reset/borrado total**.
Documenta en la privacidad cómo se ejercen (desde la app + un email de contacto) y el plazo (1 mes,
art. 12.3).

**¿DPO?** **No** es obligatorio. El art. 37 RGPD lo exige para autoridades públicas, para
«observación habitual y sistemática a gran escala» como actividad **principal**, o para tratamiento a
gran escala de **categorías especiales** (art. 9). Un tracker de patrimonio de un autónomo **no** es
ninguno de los tres: no hace *tracking* conductual masivo y los datos financieros **no** son
categoría especial. La LOPDGDD (art. 34) añade supuestos (entidades financieras, aseguradoras,
telecos, sanidad…) en los que **no** encaja un SaaS de software. Fuente: AEPD, FAQ DPD —
<https://www.aepd.es/preguntas-frecuentes/4-dpd/1-delegado-de-proteccion-de-datos/FAQ-0402-cuando-se-debe-nombrar-un-dpd>.

**¿Registro de Actividades de Tratamiento (RAT, art. 30)?** **Sí, pero interno.** La excepción de
«menos de 250 empleados» **no** te salva porque tu tratamiento **no es ocasional** (es continuo y
nuclear al servicio). Ahora bien: el RAT es un **documento interno** que **se enseña a la AEPD solo
si lo pide** — **no se presenta ni se inscribe** en ningún sitio. Es una tabla con: responsable,
fines, categorías de datos e interesados, encargados, transferencias y plazos. Fuente del art. 30 y
su excepción: <https://gdpr-text.com/read/article-30/>.

**Brechas de seguridad (arts. 33-34).** Si hay una brecha con **riesgo** para los derechos de los
usuarios, **notificar a la AEPD en ≤ 72 h** desde que tienes constancia (incluye fines de semana), y
a los **afectados** «sin dilación» si el riesgo es **alto**. No hace falta notificar si es
«improbable que constituya un riesgo». Ten un runbook mínimo (qué evaluar, plantilla, canal de la
Sede AEPD). Fuente: AEPD, guía de brechas —
<https://www.aepd.es/guias/guia-brechas-seguridad.pdf> y Sede electrónica de notificación.

---

## 4) Cookies

**Objetivo alcanzable: sin banner.** El **art. 22.2 LSSI** exige consentimiento para almacenar/leer
información en el equipo del usuario, **salvo** las cookies **estrictamente necesarias** para prestar
un servicio expresamente solicitado por el usuario o para la mera transmisión. La **Guía de cookies
de la AEPD** desarrolla esa exención: **no requieren consentimiento ni banner** las cookies técnicas
como las de **sesión, autenticación/inicio de sesión, seguridad, balanceo de carga** y las de
**preferencias elegidas por el propio usuario** (por ejemplo idioma o divisa), siempre que no se usen
para otros fines. Si worthline usa **solo** cookies de ese tipo y **ninguna** de analítica o
publicidad, **no necesita banner de consentimiento**. Fuentes: AEPD, actualización de la Guía de
cookies (2023/2024) —
<https://www.aepd.es/prensa-y-comunicacion/notas-de-prensa/aepd-actualiza-guia-cookies-para-adaptarla-a-nuevas-directrices-cepd>
y la propia Guía — <https://www.aepd.es/guias/guia-cookies.pdf>.

**Qué sí conviene hacer:** una **frase en la política de privacidad** («worthline usa únicamente
cookies técnicas necesarias para el inicio de sesión y el funcionamiento del servicio; no usamos
cookies de analítica ni publicidad, por lo que no mostramos banner de consentimiento»). Y una
**disciplina técnica**: si algún día entra un *script* de analítica/terceros que ponga cookies no
exentas, **entonces sí** hará falta banner con aceptar/rechazar al mismo nivel. Mientras la postura
«sin telemetría» se mantenga, no hay banner.

---

## 5) Consumidores: derecho de desistimiento (14 días)

**Regla general (art. 102 TRLGDCU).** En contratos a distancia el consumidor tiene **14 días
naturales** para desistir sin motivo. Para productos digitales hay dos matices:

- **Servicios digitales / SaaS (suscripción):** es un **servicio**; el desistimiento **aplica** salvo
  que el servicio se haya **ejecutado por completo** habiendo el consumidor consentido el inicio y
  reconocido que perdería el derecho una vez plenamente ejecutado (art. 103.a). Una suscripción
  mensual no se «ejecuta por completo» de golpe, así que en la práctica el consumidor **conserva** los
  14 días — y el reembolso lo gestiona el MoR.
- **Contenido digital sin soporte material (p. ej., la compra *lifetime*):** el derecho **se pierde**
  si la ejecución **comenzó** con (1) **consentimiento previo expreso** del consumidor a iniciar
  durante el plazo, (2) **conocimiento expreso de que por ello pierde el desistimiento**, y (3)
  **confirmación** del empresario (art. 103.m + art. 98.7/99.2). Los tres requisitos son
  **acumulativos**. Fuente: Iberley, art. 103 TRLGDCU —
  <https://www.iberley.es/legislacion/articulo-103-ley-defensa-consumidores-usuarios> y RDL 1/2007 —
  <https://noticias.juridicas.com/base_datos/Admin/rdleg1-2007.l2t3.html>.

**Qué gestiona el MoR y qué eliges tú.** El MoR es el vendedor legal del cobro, así que **procesa los
reembolsos** y **te exige publicar una política de reembolsos** (Paddle tiene además su propia
política de comprador). Tienes dos caminos limpios para el *lifetime*:

1. **Honrar los 14 días de reembolso** sin más (lo más sencillo y coherente con tu compromiso de
   *wind-down* de «reembolso a petición»); o
2. **Presentar la renuncia** en el checkout (casilla «quiero acceso inmediato y **entiendo que pierdo
   el derecho de desistimiento** una vez empiece el servicio») si prefieres blindar el ingreso.

Para el **trial sin tarjeta**: durante la prueba **no hay pago**, así que el desistimiento es
irrelevante hasta que el usuario paga; al convertir, empieza el plazo sobre la transacción del MoR.
Recomendación: opción 1 (reembolso 14 días) — es la más barata en fricción y la más alineada con la
promesa del *lifetime*.

---

## 6) No-asesor: mantener worthline fuera del perímetro CNMV

**La línea la marca «recomendación personalizada».** Según la **Guía de la CNMV sobre asesoramiento
en materia de inversión** (y el criterio CESR/ESMA que traspone MiFID II), para que exista
**asesoramiento** deben darse **acumulativamente** cuatro requisitos:

1. Ser una **recomendación con elemento de opinión** del prestador (no mera información o explicación
   de características y riesgos);
2. Referirse a **instrumentos financieros concretos** (no genéricos);
3. Ser **personalizada**, presentándose (explícita o implícitamente) como **idónea para esa persona**
   según sus **circunstancias personales**;
4. Realizarse por medios que **no** sean **canales de distribución genéricos**.

Si **falta cualquiera** de los cuatro, **no** es asesoramiento regulado. Las **recomendaciones
genéricas** por canales generales (web pública, prensa, etc.) y la **información simple** (describir
características) **no** son asesoramiento. Fuentes: CNMV, Guía de asesoramiento —
<https://www.cnmv.es/docportal/guias_perfil/guiaasesoramientoinversion.pdf> · CNMV/CESR,
«Understanding the definition of advice under MiFID» —
<https://www.cnmv.es/DocPortal/DocFaseConsulta/CESR/adviceMiFIDen.pdf> · CNMV, portal del inversor —
<https://www.cnmv.es/portal/inversor/asesoramiento>.

**Por qué worthline no es asesoramiento.** worthline **muestra y calcula** sobre la cartera del
propio usuario (información y herramientas), pero **no emite recomendaciones personalizadas de
compra/venta de instrumentos concretos** presentadas como idóneas para esa persona. Mientras el
asistente se mantenga en **informar, explicar y calcular** —y **no** diga «deberías comprar/vender el
fondo X» adaptado a tu perfil—, **falla el requisito (1) y/o (3)** y queda fuera del perímetro. La
custodia, la ejecución de órdenes y la recepción/transmisión de órdenes tampoco existen, así que
tampoco hay otros servicios de inversión sujetos.

**Redacción práctica del disclaimer** (alineado con el ADR 0045; ubicarlo en el asistente y en los
ToS):

> «worthline es una **herramienta de seguimiento e información** sobre tu patrimonio. **No presta
> asesoramiento en materia de inversión ni recomendaciones personalizadas** de compra o venta de
> productos financieros, no ejecuta operaciones ni custodia fondos. La información y los cálculos que
> ofrece el asistente tienen **carácter meramente informativo** y no deben interpretarse como consejo
> de inversión; las decisiones son responsabilidad del usuario.»

**Regla operativa para el equipo:** evitar en los *prompts* y en la UI del asistente formulaciones
imperativas y personalizadas del tipo «te recomiendo comprar/vender X para tu situación». Informar,
explicar escenarios y calcular es seguro; «recomendar el instrumento concreto idóneo para ti» cruza
la línea.

---

## 7) Facturación e IVA

**Al consumidor: nada que construir.** El MoR es el **vendedor de registro** y **emite la factura con
IVA** al consumidor y **liquida el IVA europeo** en cada país. Paddle lo dice expresamente: «Paddle
actúa como *reseller* de tu producto y es, por tanto, el "*seller on record*"» y «Paddle será
responsable de la recaudación y el pago del IVA en tu lugar». Fuentes:
<https://www.paddle.com/help/start/intro-to-paddle/how-paddle-is-able-to-take-on-your-vat-and-tax-responsibilities>
y <https://www.paddle.com/help/sell/tax/how-paddle-handles-vat-on-your-behalf>. Esto es **el motivo
de usar un MoR**: te evita el alta en **OSS** y el **modelo 369** trimestral (ver la investigación
hermana).

**Lo que facturas TÚ al MoR (nota para la gestoría).** Tu relación es **B2B**: tú **vendes tu producto
al MoR** y el MoR lo revende al consumidor. Es una **prestación de servicios (digitales) B2B
transfronteriza**, sujeta a **inversión del sujeto pasivo (reverse charge)**: **no repercutes IVA
español** al MoR. Paddle lo confirma: «el vendedor **no** debe cobrar IVA a Paddle en los payouts…
no se cobra impuesto a Paddle porque el suministro es imponible en el país del comprador (Paddle) por
el mecanismo de reverse charge». Fuente:
<https://www.paddle.com/help/manage/get-paid/should-i-charge-paddle-vattax-for-payouts>.

Matiz según el país de la entidad del MoR (a confirmar con la gestoría):
- **Paddle = entidad de Reino Unido** (`Paddle.com Market Ltd`). Servicio a un cliente **fuera de la
  UE** → **operación no sujeta** por reglas de localización, con **derecho a deducir** el IVA
  soportado; **no** entra en el modelo **349** (que es para operaciones **intracomunitarias**).
- **Stripe Managed Payments** — si la entidad contratante fuera **irlandesa/UE**, sería una
  **prestación intracomunitaria de servicios**: reverse charge, y **sí** habría que estar de alta en
  el **Registro de Operadores Intracomunitarios (ROI/VIES)** (modelo 036) y declarar en el **modelo
  349**. Confirmar la entidad exacta en el alta.

En ambos casos, en tus registros/IRPF, los payouts del MoR son tus **ingresos por ventas** (netos de
comisión); la comisión del MoR es **gasto deducible**. Esto es trabajo de gestoría, no de producto.

---

## 8) Lo que explícitamente NO necesitas a esta escala

| Cosa | ¿Necesaria? | Por qué / fuente |
|------|-------------|------------------|
| **DPO** | **No** | No hay observación sistemática a gran escala ni categorías especiales del art. 9; los datos financieros no son categoría especial. AEPD FAQ DPD — <https://www.aepd.es/preguntas-frecuentes/4-dpd/1-delegado-de-proteccion-de-datos/FAQ-0402-cuando-se-debe-nombrar-un-dpd> |
| **Inscripción de ficheros ante la AEPD** | **No existe** | Desde el RGPD (2018) se sustituyó por el **RAT interno**; no hay registro previo ante la AEPD. Art. 30 RGPD — <https://gdpr-text.com/read/article-30/> |
| **Banner de cookies** | **No** (si solo técnicas) | Cookies estrictamente necesarias/técnicas están **exentas** (art. 22.2 LSSI + Guía AEPD). <https://www.aepd.es/guias/guia-cookies.pdf> |
| **Licencia/registro CNMV** | **No** | No prestas servicios de inversión ni asesoramiento regulado (sección 6). Guía CNMV — <https://www.cnmv.es/docportal/guias_perfil/guiaasesoramientoinversion.pdf> |
| **Alta OSS + modelo 369 (IVA UE)** | **No** | Lo asume el **MoR** como vendedor legal. Paddle VAT — <https://www.paddle.com/help/sell/tax/how-paddle-handles-vat-on-your-behalf> |
| **Sociedad (SL)** | **No** | El **autónomo** puede prestar el servicio y facturar al MoR; nada en LSSI/RGPD lo impide (art. 10 LSSI contempla al prestador persona física). |
| **Evaluación de impacto (EIPD, art. 35)** | **Probablemente no** | Solo si el tratamiento es «de alto riesgo» (perfilado a gran escala, categorías especiales…), que no es el caso; revisar la lista de la AEPD si se añade *scoring*/perfilado. |

---

## Lo que no pude verificar en fuente primaria

- **Guía de cookies de la AEPD (PDF) y FAQ de cookies:** el PDF oficial devolvió contenido binario y
  la FAQ dio HTTP 500; el criterio (cookies técnicas/necesarias y preferencias del usuario **exentas**,
  sin banner si no hay analítica) está confirmado por la **nota de prensa oficial de la AEPD** y por el
  desarrollo del art. 22.2 LSSI, pero **no** pude fijar el literal exacto del apartado de exenciones de
  la Guía.
- **Guía CNMV (PDF):** el PDF llegó como binario; los **cuatro requisitos acumulativos** del
  asesoramiento provienen del contenido oficial de la CNMV/CESR (portal del inversor + documento CESR),
  pero no pude citar el literal página a página del PDF.
- **Certificación DPF concreta de cada proveedor** (Vercel, WorkOS, Resend, Turso, Google): confirmé
  que sus DPA ofrecen **SCC** (y Sentry menciona DPF+SCC), pero **no** verifiqué uno a uno el estado de
  certificación DPF en la lista oficial <https://www.dataprivacyframework.gov>. Acción de diligencia:
  comprobarlo por proveedor antes de publicar la privacidad.
- **Entidad contratante exacta de Stripe Managed Payments** (país) para determinar si tus facturas al
  MoR son **intracomunitarias** (modelo 349 + ROI) o **exportación** — depende de la entidad que
  aparezca en tu contrato; confirmar en el alta.
- **Ubicación de almacenamiento de datos de Turso** (región UE vs. EE. UU.): la política no fija región;
  su DPA existe y se firma desde la cuenta, pero la residencia concreta hay que configurarla/confirmarla.
- **Necesidad o no de domicilio postal completo en el aviso legal:** el art. 10 exige «residencia o
  domicilio o… establecimiento» **y** un medio de comunicación directa y efectiva; hay lectura de que
  un email efectivo basta para un autónomo, pero la práctica prudente incluye un domicilio a efectos de
  notificaciones. Punto a decidir con la gestoría/abogado.

---

## Índice de fuentes primarias

- **BOE — Ley 34/2002 (LSSI-CE), art. 10, 20-21, 27:** <https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758>
- **BOE — RDL 1/2007 (TRLGDCU), desistimiento (arts. 102-103):** <https://noticias.juridicas.com/base_datos/Admin/rdleg1-2007.l2t3.html> · art. 103 (Iberley): <https://www.iberley.es/legislacion/articulo-103-ley-defensa-consumidores-usuarios>
- **AEPD — Actualización Guía de cookies (nota de prensa):** <https://www.aepd.es/prensa-y-comunicacion/notas-de-prensa/aepd-actualiza-guia-cookies-para-adaptarla-a-nuevas-directrices-cepd>
- **AEPD — Guía de cookies (PDF):** <https://www.aepd.es/guias/guia-cookies.pdf>
- **AEPD — FAQ: cuándo es obligatorio un DPD:** <https://www.aepd.es/preguntas-frecuentes/4-dpd/1-delegado-de-proteccion-de-datos/FAQ-0402-cuando-se-debe-nombrar-un-dpd>
- **AEPD — Guía de notificación de brechas (PDF):** <https://www.aepd.es/guias/guia-brechas-seguridad.pdf>
- **RGPD — art. 30 (RAT) y su excepción:** <https://gdpr-text.com/read/article-30/>
- **CNMV — Guía sobre asesoramiento en materia de inversión (PDF):** <https://www.cnmv.es/docportal/guias_perfil/guiaasesoramientoinversion.pdf>
- **CNMV/CESR — Understanding the definition of advice under MiFID:** <https://www.cnmv.es/DocPortal/DocFaseConsulta/CESR/adviceMiFIDen.pdf>
- **CNMV — Portal del inversor, asesoramiento:** <https://www.cnmv.es/portal/inversor/asesoramiento>
- **Comisión Europea — EU-US Data Privacy Framework (transferencias):** <https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/eu-us-data-transfers_en>
- **Vercel — DPA:** <https://vercel.com/legal/dpa>
- **Turso — Privacy Policy / Trust Center:** <https://turso.tech/privacy-policy> · <https://trust.turso.tech/faq>
- **WorkOS — DPA:** <https://workos.com/legal/data-processing-addendum>
- **Resend — DPA:** <https://resend.com/legal/dpa>
- **Sentry — DPA (SCC + DPF):** <https://sentry.io/legal/dpa/>
- **Google — Gemini API, política de logging/datos:** <https://ai.google.dev/gemini-api/docs/logs-policy>
- **Groq — Your Data in GroqCloud:** <https://console.groq.com/docs/your-data>
- **Cerebras — Privacy Policy / retención:** <https://www.cerebras.ai/privacy-policy> · <https://support.cerebras.net/articles/1811589793-does-cerebras-retain-my-data>
- **Paddle — Cómo asume el IVA / reseller:** <https://www.paddle.com/help/start/intro-to-paddle/how-paddle-is-able-to-take-on-your-vat-and-tax-responsibilities> · <https://www.paddle.com/help/sell/tax/how-paddle-handles-vat-on-your-behalf>
- **Paddle — ¿Debo cobrar IVA a Paddle en los payouts? (reverse charge):** <https://www.paddle.com/help/manage/get-paid/should-i-charge-paddle-vattax-for-payouts>
