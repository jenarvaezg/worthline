# Auditoría de claims para la landing: IA, importación y MCP

> Ticket [#859](https://github.com/jenarvaezg/worthline/issues/859) del mapa wayfinder [#856](https://github.com/jenarvaezg/worthline/issues/856) («Evoluciona tu Excel»). Corte: **2026-07-10**. Fuentes: código en `main`, ADRs, PRDs e issues vivas. Regla rectora del mapa: la landing no convierte planes en funcionalidades disponibles, y distingue siempre **lectura MCP** de **mutaciones confirmables**.

## Cómo leer la matriz

- **Shipped** = en `main` y operativo en hosted hoy.
- **Decidido** = PRD aprobado / `ready-for-agent`, **cero código**. Solo puede aparecer en la landing como visión, jamás como capacidad.
- **Lenguaje seguro** = formulación que el producto de hoy respalda sin matices.
- **Overclaim** = formulaciones concretas que hoy serían falsas o engañosas.

## Pilar 1 · Visión patrimonial precisa

| Capacidad | Estado | Evidencia |
|---|---|---|
| Patrimonio completo en una imagen (activos + deudas, composición, drill) | **Shipped** | dashboard + composición; multi-tenant hosted (#381, ADR 0030) |
| Histórico congelado y auditable; snapshots diarios automáticos | **Shipped** | ADR 0008; cron diario #528 (ADR 0037) |
| Retornos reales por posición (IRR + TWR) | **Shipped** | #547 (ADR 0040), slices #548–551 |
| Cobros (dividendos/intereses/renta) como atribución, nunca inventados como cifra | **Shipped** | #652 (ADR 0054), S1–S4 cerrados |
| Look-through de exposición (geografía/divisa/clase) | **Shipped (v1)** | #539/#544, cerrados 2026-07-04 |
| Proyecciones FIRE + objetivos + lente renta pasiva | **Shipped** | #421, #507, #658 |
| «Origen del cambio» (mercado vs ahorro), «Salud de datos» en la home, plan de aportaciones | **Decidido, sin código** | #653, #654, #553 — slices abiertos |

- **Lenguaje seguro**: «Todo tu patrimonio, por fin en una sola imagen» está respaldado. También: histórico que no se reescribe, retornos IRR/TWR reales, exposición look-through, FIRE.
- **Overclaim**: cualquier alusión a «entiende de dónde viene cada cambio de tu patrimonio» (es #653, decidido), a salud/calidad de datos visible para el humano (#654: hoy solo la ve el agente), o a planificación de aportaciones (#553).
- **Matiz de exposición**: los perfiles van a migrar a catálogo global curado por admin (#711, ADR 0058) y el agent-fill de usuario se retira. No anclar copy a «la IA clasifica tu exposición»: esa mecánica concreta está en transición.

## Pilar 2 · Actualización e importación menos manual

| Capacidad | Estado | Evidencia |
|---|---|---|
| Import de extracto de broker (CSV/Excel) con preview confirmable, multi-ISIN | **Shipped** | #173 + #669 (multi-ISIN); fix de signo #743 |
| Wizard guiado de alta de posiciones | **Shipped** | #593 (S0–S5 cerrados) |
| Fuentes conectadas: Binance (cripto) y Numista (numismática), sync con un clic | **Shipped** | #245 (ADR 0021), #160 |
| Precios automáticos (mercado + cripto) con cadencia honesta | **Shipped** | ADR 0031 (#389); CoinGecko/Stooq |
| Subir capturas/excels al chat del asistente | **Decidido, sin código** | PRD #865 (`ready-for-agent`) |
| Reconstruir tu historia subiendo documentos (extractos, cuadros de amortización, tasaciones) | **Decidido, sin código** | PRD #764 (ADR 0059); consume #865 |
| Conexión bancaria automática (PSD2 / open banking) | **Descartado** | matado en el grill 2026-07-02; manual-first es decisión, no carencia |

- **Lenguaje seguro**: «importa el extracto de tu broker y confírmalo con preview», «sincroniza Binance y Numista», «precios al día sin teclear». El salto Excel→worthline se apoya en import + wizard + export (pilar 4), no en promesas de ingesta conversacional.
- **Overclaim**: «sube cualquier documento y worthline lo entiende» (#764/#865, sin código); «conecta tu banco» (descartado a propósito — si se menciona, como elección de diseño: tus datos no pasan por un agregador bancario); «importa desde cualquier broker» (los mappers cubren formatos concretos; decir «tu extracto CSV/Excel» sin lista de brokers).

## Pilar 3 · IA con preview y confirmación

| Capacidad | Estado | Evidencia |
|---|---|---|
| Asistente en la app que responde sobre TUS datos citando cifras reales | **Shipped** | #627; tools de solo lectura sobre agent view (ADR 0047/0048) |
| El asistente jamás escribe ni calcula dinero; los hechos vienen de tools | **Shipped (principio arquitectónico)** | ADR 0048/0053; `chat-tools.ts` recibe solo el read store |
| Propuesta IA confirmable (propose→preview→confirm) | **Shipped solo para perfiles de exposición** | ADR 0044 (#544) — y ese path de usuario se retira en #711 |
| Calidad validada por evals (golden set) antes de cambiar de modelo | **Shipped (interno)** | #668; harness `eval:assistant` |
| Pool de proveedores con failover | **Decidido, sin código** | PRD #704 (`ready-for-agent`, mapa #837) |
| Adjuntos en el chat (capturas/excel) con extractor dedicado | **Decidido, sin código** | PRD #865 |
| Ingesta de documentos como propuestas confirmables | **Decidido, sin código** | PRD #764 |

- **Lenguaje seguro**: «un asistente que responde sobre tus datos, con las cifras reales de tu cuenta — no estimaciones de un LLM»; «la IA nunca escribe en tus datos» (hoy es literalmente cierto: el chat es read-only). El principio «propone, tú confirmas» puede contarse como **filosofía de diseño** (ADRs 0044/0048/0053/0059 lo fijan), pero no ilustrarlo con flujos de ingesta que no existen.
- **Overclaim**: «sube tu extracto al chat», «la IA rellena tu cartera», «tu asistente importa documentos» — todo eso es #865/#764, decidido y sin una línea de código. También evitar «IA gratis/ilimitada»: el pool #704 no está implementado y el aviso de servicios de terceros (requisito de #704) tampoco.
- **Nota de honestidad**: si la landing enseña el chat en capturas, que sea el chat read-only real (responde, explica, sugiere acciones de navegación), no un mock de ingesta.

## Pilar 4 · Control y trazabilidad

| Capacidad | Estado | Evidencia |
|---|---|---|
| Export completo del workspace en JSON (un clic, tus datos son tuyos) | **Shipped** | `ajustes/export` → `worthline-export-<fecha>.json` |
| Historia inmutable: explicar nunca reescribe; correcciones auditables y reversibles | **Shipped** | ADR 0008/0023; papelera + trash summary |
| DB por workspace (aislamiento real de tenant) | **Shipped** | #381, ADR 0030 |
| Demo pública completa con personas ficticias | **Shipped** | #297 — worthline-web.vercel.app |
| Tiers de procedencia de datos (`source: agent`, reconciliado/no verificado) | **Decidido, sin código** | #764 S4 |

- **Lenguaje seguro**: «tus datos salen contigo en un JSON», «tu histórico nunca se reescribe», «cada workspace en su propia base de datos», «pruébalo en la demo sin cuenta».
- **Overclaim**: procedencia/reconciliación de datos ingeridos por IA (futuro #764).

## Pilar 5 · MCP como capacidad avanzada

| Capacidad | Estado | Evidencia |
|---|---|---|
| Servidor MCP con OAuth: Claude u otro cliente lee tu patrimonio | **Shipped** | MCP OAuth live (WorkOS); agent view completo vía MCP (#328) |
| Catálogo de lecturas rico: contexto financiero, explicación de cifras, histórico, retornos, payouts, calidad de datos, FIRE… | **Shipped** | `agent-view/catalog.ts` — mismo catálogo para HTTP, MCP y asistente |
| **Solo lectura**: cero mutaciones por MCP | **Shipped (y es el claim)** | el catálogo no expone escrituras; writes solo en la app con confirmación |
| MCP de plan de aportaciones / what-if | **Decidido, sin código** | #553 S5 (#559) |

- **Lenguaje seguro**: «conecta tu agente (Claude, o cualquier cliente MCP) a tus datos con OAuth — lectura completa, escritura ninguna». La asimetría lectura-sí/escritura-no es un claim de confianza, véndase como tal.
- **Overclaim**: «tu agente puede operar tu cartera por MCP», «automatiza cambios vía API» — no existen mutaciones MCP y no están planificadas fuera de #559 (y aun ese es what-if/plan, no operaciones).

## Reglas transversales para el copy

1. **Tiempo verbal como gate**: presente («importa», «responde», «exporta») solo para filas Shipped. Todo lo Decidido, si aparece, en sección de visión/roadmap claramente separada — o no aparece.
2. **La IA se muestra contenida** (nota del mapa: la IA no dicta la estética ni la promesa central): el claim fuerte hoy es *precisión + control*, con la IA como asistente honesto de solo lectura.
3. **Capturas**: solo producto real con datos de demo (nota del mapa). Superficies que cambiarán con «Libro mayor» (#825) — retrasar el shot list final hasta que la home migrada esté estable; el ticket de prototipo (#862) hereda esta matriz.
4. **Dependencias futuras encadenadas**: si algún copy de visión menciona ingesta por chat, su cadena real es #704 → #865 → #764 (reparto comentado en ambos PRDs el 2026-07-10). Nada de esa cadena tiene código.
5. **Revisitar esta matriz** cuando se cierre cualquier slice de #704/#865/#764/#653/#654/#553: cada cierre mueve filas de Decidido a Shipped y relaja el copy permitido.
