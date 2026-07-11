# Análisis técnico de Sure (upstream)

Fecha de revisión: 2026-07-11  
Repositorio: <https://github.com/we-promise/sure>  
Commit fijado: [`8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe`](https://github.com/we-promise/sure/tree/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe) (2026-07-08)  
Versión declarada: `0.7.3-alpha.2`

## Resumen ejecutivo

Sure es una aplicación de finanzas personales **self-hostable, amplia y operacionalmente madura**, heredera del producto Maybe Finance. No es sólo un dashboard de patrimonio: combina agregación bancaria, libro de actividad financiera, valoración histórica, inversiones, presupuestos, reglas, objetivos, colaboración familiar, importadores, API, MCP, asistente con LLM y una aplicación Flutter.

Su principal ventaja no es una única innovación técnica, sino la cantidad de bucles completos que ya cierra: conexión/importación → normalización → reconciliación → materialización histórica → informes → corrección manual → resincronización. También destaca el cuidado de distribución: Docker multi-arquitectura, Compose, Helm, backups, observabilidad y app móvil.

La contrapartida aparece claramente en el propio código y backlog. El monolito Rails ha crecido hasta **115 tablas**, **588 ficheros bajo `app/models`**, **174 controladores** y una tabla de rutas de **762 líneas**. La lógica de proveedores está repetida, el núcleo mezcla persistencia con orquestación y cálculos, y las issues abiertas documentan N+1, scans completos, condiciones de carrera, inconsistencias de permisos y errores contables. Es una referencia muy buena para producto y para ciertos patrones de cálculo/sincronización, pero no un plano que convenga copiar literalmente.

## 1. Qué es y cómo funciona

### Flujo funcional principal

1. Una `Family` actúa como tenant financiero y contiene usuarios, cuentas, categorías, proveedores, reglas, presupuestos, objetivos y documentos.
2. Una `Account` pertenece a esa familia y delega su tipo concreto a un `accountable` (`Depository`, `Investment`, `Property`, `Vehicle`, `Loan`, etc.). La clasificación activo/pasivo se almacena como columna generada en PostgreSQL.
3. Toda actividad se representa con `Entry`, que a su vez delega a `Transaction`, `Trade` o `Valuation`. Así se unifican timeline, transferencias, splits y cálculos sin forzar todos los campos en una sola tabla.
4. Las conexiones externas crean modelos `*_item` (conexión/credenciales/estado) y `*_account` (cuenta remota y payloads). Sus procesadores traducen datos remotos a cuentas, entries, holdings y snapshots locales.
5. `Syncable` crea un `Sync`, consolida ventanas solapadas bajo bloqueo y encola `SyncJob`. Una sincronización familiar se abre en abanico hacia proveedores y cuentas; después ejecuta matching de transferencias y reglas.
6. Los balances y holdings diarios se **materializan en tablas propias** mediante calculadores forward/reverse y `upsert_all`. Las cuentas manuales se calculan hacia delante desde su actividad; las conectadas pueden reconstruirse hacia atrás desde el balance autoritativo del proveedor.
7. La UI Rails/Hotwire consulta esas series ya materializadas para patrimonio, gráficos e informes, mientras Sidekiq asume syncs, enriquecimiento y trabajo pesado.

Fuentes: [`Account` y su delegated type](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/account.rb#L1-L99), [`Entry` y `Entryable`](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/entry.rb#L1-L24), [orquestación de sync](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/concerns/syncable.rb#L1-L44), [fan-out familiar](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/family/syncer.rb#L1-L49), [materialización de balances](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/balance/materializer.rb#L1-L120), [schema](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/db/schema.rb).

## 2. Arquitectura y stack

### Monolito Rails con frontend server-driven

- Ruby 3.4.9 y Rails 8.1.
- PostgreSQL como fuente de verdad; usa UUID, JSONB, constraints, índices parciales y columnas generadas.
- Rails views + Turbo + Stimulus, ViewComponent y Tailwind v4/Propshaft. Importmap evita un bundle JS de aplicación tradicional.
- Sidekiq + Redis, colas ponderadas y tareas cron; `sidekiq-unique-jobs` complementa la deduplicación del dominio.
- Pundit, Doorkeeper OAuth, API keys, Rack Attack/CORS, OIDC/SAML/OAuth, WebAuthn y TOTP.
- Active Storage local/S3/GCS.
- OpenAI y Anthropic, con herramientas financieras internas, streaming, registro de uso, evaluaciones y Langfuse.
- Flutter para Android/iOS/web, consumiendo la API y con almacenamiento offline local.

Fuentes: [`Gemfile`](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/Gemfile), [configuración Rails](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/config/application.rb#L9-L64), [colas](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/config/sidekiq.yml), [`mobile/pubspec.yaml`](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/mobile/pubspec.yaml).

### Organización real del código

La separación nominal es Rails convencional (`models`, `controllers`, `views`, `jobs`, `services`, `components`), pero el dominio vive principalmente bajo `app/models`: además de records contiene calculadores, importadores, sincronizadores, adaptadores y value-like objects. Ejemplos: `Balance::Materializer`, `BalanceSheet::*`, `Provider::*`, `Assistant::*` y docenas de procesadores por integración.

Esto tiene dos lecturas:

- Positiva: el dominio está nombrado, tiene objetos pequeños en muchas zonas y evita un único “god service”. La navegación por namespace suele contar una historia coherente.
- Negativa: la frontera “modelo” deja de comunicar qué persiste, qué calcula y qué orquesta. La autoload tree contiene 588 ficheros y el núcleo está acoplado a Active Record, callbacks, `Current`, jobs y proveedores. `Account` (661 líneas) y `Family` (450) siguen siendo agregados muy anchos.

La repetición es especialmente visible en proveedores: rutas, `*_item`, `*_account`, connectables, importers, processors, syncers y unlinking se replican por Plaid, SimpleFIN, Enable Banking, Akahu, Lunchflow, Brex, Mercury, Coinbase, Binance, Kraken, CoinStats, IBKR, Indexa, Questrade, SnapTrade y Up. La reflexión usada para descubrir asociaciones `*_items` reduce listas manuales, pero también confirma que el contrato de plugin todavía depende de convenciones sobre Active Record. Véanse el [descubrimiento por reflexión](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/family/syncer.rb#L27-L49) y la [repetición en rutas de proveedores](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/config/routes.rb#L7-L181).

## 3. Modelo de dominio

### Decisiones fuertes y valiosas

**Tenant familiar y permisos por cuenta.** `Family` es el límite de datos, pero `Account` añade owner, shares, `full_control` e inclusión opcional en las finanzas del receptor. Los scopes `accessible_by`, `writable_by` e `included_in_finances_for` expresan tres conceptos distintos que muchas aplicaciones confunden. [Fuente](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/account.rb#L69-L92).

**Actividad unificada mediante delegated types.** `Entry` aporta fecha, importe, moneda, exclusión, cuenta, transfer y árbol de splits; `Transaction`/`Trade`/`Valuation` aportan semántica específica. Es un compromiso razonable entre STI y tablas completamente separadas. [Fuente](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/entry.rb#L1-L29).

**Balances como proyección reproducible.** Sure no confía sólo en el saldo actual. Conserva actividad y materializa series diarias, lo que permite patrimonio histórico, cash flow y reconstrucción. `upsert_all` sobre clave `(account_id, date, currency)` hace idempotente la persistencia. [Fuente](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/balance/materializer.rb#L56-L73).

**Autoridad de datos explícita en holdings.** Los snapshots de proveedor tienen prioridad; el coste manual bloqueado se preserva; los calculados rellenan historia. El código intenta resolver procedencia y precedencia, no sólo “último write gana”. [Fuente](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/holding/materializer.rb#L45-L129).

**Estados explícitos.** Cuentas y syncs usan máquinas de estado con transiciones, timestamps y estados terminales. La ventana visible de 5 minutos permite recuperarse de jobs perdidos, mientras una limpieza posterior marca syncs realmente stale. [Fuente](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/sync.rb#L1-L59).

### Riesgos del modelo

- La misma verdad financiera aparece en `entries`, `transactions/trades/valuations`, `balances`, `holdings`, `accounts.balance/cash_balance` y payloads de proveedor. Es potente, pero cada mutación necesita invalidar o reconstruir varias proyecciones correctamente.
- Hay callbacks y efectos asíncronos alrededor de creación/borrado/sync. Por ejemplo, crear una cuenta persiste opening balance, auto-share y luego dispara sync; el comportamiento del agregado excede con mucho una transacción CRUD. [Fuente](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/account.rb#L166-L197).
- `Entry` usa `date`, no un timestamp de negocio. La issue [#2603](https://github.com/we-promise/sure/issues/2603) pide conservar orden intradía de CSV y [#2261](https://github.com/we-promise/sure/issues/2261) señala que móvil envía sólo fecha. Esto limita ledger, conciliación y UX cuando varias operaciones del día necesitan orden estable.
- La conversión multimoneda es transversal y aún admite fallbacks peligrosos: [#2417](https://github.com/we-promise/sure/issues/2417) denuncia conversión silenciosa a 1.0 si falta tipo de cambio; [#2622](https://github.com/we-promise/sure/issues/2622) pide totales diarios en moneda base.

## 4. Capacidades de producto y UX

### Superficie funcional observada

- Dashboard de patrimonio y cuentas, con orden y widgets configurables.
- Activos y pasivos manuales: bancos, inversiones, cripto, inmuebles, vehículos, préstamos, tarjetas y otros.
- Ingesta automática mediante múltiples agregadores/brokers/exchanges y carga CSV/QIF/PDF; importación desde Mint y Actual.
- Timeline de transacciones, trades y valuations; categorías jerárquicas, merchants, tags, splits, transfers, pending y exclusiones.
- Reglas automáticas, auto-categorización, detección de merchant y matching de transferencias.
- Presupuesto mensual, informes de ingresos/gastos, patrimonio, inversiones y exportación.
- Objetivos con cuentas de financiación, pledges y estados pause/resume/complete/archive.
- Usuarios familiares, roles, invitaciones, ownership y account sharing.
- AI chat con herramientas para consultar cuentas, balance sheet, income statement, holdings, budget y transacciones, y para crear/actualizar categorías/tags/objetivos o importar extractos.
- API REST documentada, OAuth/API keys y servidor MCP que reutiliza las mismas herramientas del asistente.
- MFA, passkeys, SSO, audit/impersonation y modos managed/self-hosted.
- Flutter con dashboard, cuentas, transacciones, chat, biometría, privacy mode, configuración de backend y cola/sync offline.

Fuentes: [rutas de aplicación](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/config/routes.rb), [funciones del asistente](https://github.com/we-promise/sure/tree/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/assistant/function), [API docs](https://github.com/we-promise/sure/tree/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/docs/api), [estructura móvil](https://github.com/we-promise/sure/tree/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/mobile/lib).

### UX y sistema de diseño

Sure ha construido una capa visual reusable con ViewComponent (`DS::Button`, `Dialog`, `Menu`, `Popover`, `Tabs`, `Toggle`, `Tooltip`, etc.), previews Lookbook y controladores Stimulus junto al componente. Los tokens usan formato DTCG, semver y una fuente JSON que compila a Tailwind; contienen aliases semánticos y variantes dark. Esa infraestructura es transferible a web y tooling externo, y la app Flutter ya replica tipografía/colores/spacing en una capa propia.

Es una práctica especialmente buena que el contrato visual tenga versión y build verificable, no sea sólo una página de Figma. [Fuente del contrato de tokens](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/design/tokens/README.md#L1-L38), [tokens semánticos y dark mode](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/design/tokens/sure.tokens.json#L1-L45), [componentes](https://github.com/we-promise/sure/tree/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/components/DS).

No obstante, el sistema todavía está en migración. Las issues periódicas `ds-drift`, [#2134](https://github.com/we-promise/sure/issues/2134) (paridad dark), [#2135](https://github.com/we-promise/sure/issues/2135) (Card/ListGroup), [#2136](https://github.com/we-promise/sure/issues/2136) (focus/a11y) y [#2235](https://github.com/we-promise/sure/issues/2235) (alinear Flutter) muestran que el contrato existe antes de que todo el producto lo consuma de forma uniforme.

## 5. Rendimiento

### Técnicas acertadas

- **Proyecciones materializadas en aplicación** para no recalcular todo el historial en cada request.
- **Persistencia bulk** con `upsert_all` y claves únicas para balances/holdings.
- **Recalculo incremental por ventana** y purga acotada de filas stale.
- **Sync deduplicado bajo lock**: una petición concurrente expande la ventana del sync visible en lugar de encolar otro.
- **Trabajo asíncrono** y colas con prioridad/peso.
- **Eager load y preloading de Puma**, Bootsnap precompilado, assets precompilados y cache Redis opcional.
- **Memoización de objetos de informe e historial de chat**; el responder carga mensajes y tool calls una sola vez.
- **Observabilidad dedicada**: Skylight público, Sentry, rack-mini-profiler, Vernier, StackProf y derailed benchmarks.

Fuentes: [bulk e incremental balances](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/balance/materializer.rb#L56-L118), [coalescing de sync](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/concerns/syncable.rb#L12-L43), [producción Rails](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/config/environments/production.rb#L6-L17), [Puma](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/config/puma.rb#L5-L39), [historial AI memoizado](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/assistant/responder.rb#L120-L143).

### Cuellos de botella confirmados por el upstream

El backlog no deja dudas de que la materialización no elimina el coste de lectura ni la complejidad de sync:

- Dashboard de ~10 s: [#2270](https://github.com/we-promise/sure/issues/2270); SQL repetido: [#2262](https://github.com/we-promise/sure/issues/2262).
- N+1 en actividad de cuenta: [#2462](https://github.com/we-promise/sure/issues/2462), listado de cuentas: [#2446](https://github.com/we-promise/sure/issues/2446), presupuesto: [#2445](https://github.com/we-promise/sure/issues/2445), categorías: [#2164](https://github.com/we-promise/sure/issues/2164), reglas: [#2259](https://github.com/we-promise/sure/issues/2259).
- Matching de transferencias hace full-table scan por sync familiar: [#2447](https://github.com/we-promise/sure/issues/2447).
- La configuración por defecto es conservadora (3 threads, 1 Puma worker) y apropiada para self-hosting pequeño, pero no compensa endpoints con query amplification.

La oportunidad arquitectónica evidente es separar **read models por pantalla** de los aggregates Active Record y establecer presupuestos de queries/latencia en tests. Sure ya tiene un helper `SqlQueryCapture`, pero su CI no presenta un gate general de performance; las regresiones se descubren por Skylight o issues.

## 6. AI, API y MCP

Sure hace algo poco común y valioso: define funciones financieras una vez y las reutiliza tanto en el chat como en MCP. El servidor MCP implementa JSON-RPC `initialize`, `tools/list` y `tools/call`, autentica por OAuth o token de entorno, comprueba usuario activo y crea una sesión limpia para evitar heredar impersonación. [Fuente](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/controllers/mcp_controller.rb#L1-L155).

El chat soporta streaming y un ciclo de tool calls. Mantiene el par call/result al recortar historia para no producir conversaciones inválidas. [Responder](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/assistant/responder.rb#L13-L95), [history trimmer](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/app/models/assistant/history_trimmer.rb#L1-L52).

Sus límites también son explícitos:

- El responder corta la recursión tras el follow-up para controlar gasto; eso impide cadenas arbitrarias de herramientas y se relaciona con [#2241](https://github.com/we-promise/sure/issues/2241), donde el asistente queda en “Thinking…” con múltiples calls.
- [#2292](https://github.com/we-promise/sure/issues/2292) muestra feature detection acoplada a OpenAI aunque Anthropic esté configurado.
- La API y MCP amplifican el coste de cualquier error de autorización. El backlog incluye exposiciones o bypasses en holdings [#2467](https://github.com/we-promise/sure/issues/2467), bulk updates [#2099](https://github.com/we-promise/sure/issues/2099), imports [#2064](https://github.com/we-promise/sure/issues/2064), trades [#2055](https://github.com/we-promise/sure/issues/2055) y filtros de reports [#2092](https://github.com/we-promise/sure/issues/2092). La existencia de scopes correctos no garantiza su aplicación consistente en cada endpoint.

## 7. Tests, seguridad y entrega

### Cobertura de verificación

El repositorio contiene aproximadamente 695 ficheros de test Rails/Minitest, 31 specs RSpec —principalmente request/OpenAPI— y 28 tests Flutter. Minitest corre en paralelo y usa fixtures, VCR/WebMock, Capybara/Selenium y captura SQL. RSpec/rswag genera y valida la API.

CI separa Brakeman/hardening, audit de importmap, Rubocop, Biome, tests unit/integration y system tests con PostgreSQL y Redis reales; guarda screenshots al fallar. Las actions están fijadas por SHA y checkout desactiva credenciales persistentes. [CI](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/.github/workflows/ci.yml#L1-L193), [test helper](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/test/test_helper.rb#L1-L90).

Puntos débiles:

- SimpleCov sólo se activa con `COVERAGE=true`; el workflow CI revisado no lo activa ni impone umbral.
- Conviven Minitest y RSpec, aumentando coste cognitivo y duplicación de setup.
- Los system tests se desparalelizan en CI y existe una flaky reconocida por carrera con Turbo ([#2420](https://github.com/we-promise/sure/issues/2420)).
- No se ve en el workflow principal un gate de migración desde versiones anteriores; [#2653](https://github.com/we-promise/sure/issues/2653) reporta precisamente un error de migración.

### Distribución y operaciones

- Docker multi-stage, usuario no-root, Bootsnap y assets precompilados.
- Compose con web, worker, PostgreSQL 16, Redis, health checks, volúmenes y perfil opcional de backups.
- Imágenes GHCR multi-arquitectura y publicación versionada.
- Helm oficial con web/Sidekiq, CloudNativePG, Redis operator, external secrets, HA y opciones de backup.
- Mobile CI para Android e iOS, con artefactos, firma condicional y flujos de distribución.

Fuentes: [Dockerfile](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/Dockerfile), [Compose](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/compose.example.yml#L45-L163), [Helm chart](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/charts/sure/Chart.yaml), [Flutter build](https://github.com/we-promise/sure/blob/8d649bc5b9fe9a1730cde1e9482d6dbed96c87fe/.github/workflows/flutter-build.yml).

Riesgos operativos observables: Compose publica un `SECRET_KEY_BASE` por defecto útil para arrancar pero fácil de dejar en producción; Redis usa `latest`; Active Record encryption es opcional y la issue [#2422](https://github.com/we-promise/sure/issues/2422) evidencia que activarla sobre instalaciones existentes no es trivial.

## 8. Limitaciones estructurales

1. **Breadth tax.** Cada nuevo proveedor multiplica modelos, rutas, settings, importadores, casos de conciliación y pruebas. La issue [#2546](https://github.com/we-promise/sure/issues/2546) dice que incluso el generador oficial se ha desalineado de la arquitectura de provider registry.
2. **Consistencia financiera frágil.** Cost basis, transfers, exclusions, pending, FX, balance snapshots y categorías interactúan. Las issues [#2475](https://github.com/we-promise/sure/issues/2475), [#2541](https://github.com/we-promise/sure/issues/2541), [#2086](https://github.com/we-promise/sure/issues/2086), [#2052](https://github.com/we-promise/sure/issues/2052) y [#2074](https://github.com/we-promise/sure/issues/2074) afectan cifras, no sólo UI.
3. **Concurrencia incompletamente domesticada.** Hay locks y state machines, pero persisten carreras en matching [#2471](https://github.com/we-promise/sure/issues/2471), holdings [#2122](https://github.com/we-promise/sure/issues/2122) y jerarquía de sync [#2090](https://github.com/we-promise/sure/issues/2090).
4. **Autorización dispersa.** Tres scopes de cuenta y roles flexibles son potentes; exigir que cada query los mezcle manualmente es propenso a bypasses, como confirma el backlog de API.
5. **UI contract en transición.** Hay excelentes fundamentos, pero web y Flutter todavía tienen drift, primitives ausentes y estados sin feedback ([#2464](https://github.com/we-promise/sure/issues/2464), [#2329](https://github.com/we-promise/sure/issues/2329)).
6. **Importador y normalización internacional.** El número, fecha, espacio no separable y moneda siguen generando pérdida o ambigüedad ([#2537](https://github.com/we-promise/sure/issues/2537), [#2603](https://github.com/we-promise/sure/issues/2603)).
7. **Gran superficie de mantenimiento.** 115 tablas y centenares de objetos permiten mucha funcionalidad, pero hacen más difícil demostrar invariantes globales o realizar cambios core sin una matriz extensa de regresión.

## 9. Patrones que merece la pena reutilizar

1. **Ledger/activity canónico + proyecciones derivadas**, con un comando explícito de reconstrucción y claves idempotentes.
2. **Procedencia y prioridad de dato** como parte del dominio (`manual locked > provider snapshot > calculated`), no como convención implícita.
3. **Sync como entidad observable**, con estado, ventanas, parent/children, stats, error y recovery; no jobs opacos.
4. **Coalescing de ventanas bajo lock** para evitar tormentas de sync.
5. **Funciones financieras compartidas entre UI AI y MCP**, manteniendo autorización en el borde.
6. **Design tokens versionados y compilados** como contrato verificable.
7. **Self-hosting tratado como producto**: instalación, health, backup, upgrades, multi-arch y secretos.
8. **VCR + proveedor sandbox + tests de system reales** para integraciones externas.

## 10. Patrones que conviene mejorar antes de adoptar

1. Definir un **puerto de proveedor** estable (`discover_accounts`, `fetch_transactions`, `fetch_positions`, `fetch_balances`, cursors, capabilities) y adapters fuera de Active Record; generar boilerplate desde el contrato y contract-test suite.
2. Separar comandos financieros de records: `RecordTransaction`, `ReconcileTransfer`, `RebuildAccountProjection`, etc., con transaction boundary e invariantes explícitas.
3. Hacer que autorización sea **secure by construction**: repositories/query objects parten siempre del principal y devuelven sólo scope autorizado; evitar `family.transactions` como punto de entrada accidental.
4. Añadir una tabla/event log de **provenance e import run** que explique qué proveedor/cursor/payload creó o cambió cada hecho y permita rollback/replay selectivo.
5. Modelar `occurred_at`/orden externo además de `date`, conservando precisión y timezone del origen.
6. Crear read models de dashboard/reporting y budgets con tests de número máximo de queries y budgets de p95.
7. Ejecutar tests de propiedades sobre dinero, FX, signos, transferencias y holdings; los ejemplos unitarios no cubren bien combinatoria financiera.
8. Probar migrations desde al menos la última release y un snapshot con datos, no sólo `db:schema:load` limpio.
9. Unificar framework de tests o documentar una frontera estricta (p. ej. Minitest dominio/UI, RSpec sólo contract OpenAPI).
10. Convertir el design-system drift patrol en lint/gate automático cuando sea posible, y compartir tokens generados con Flutter desde la misma fuente.

## Conclusión

Sure es una referencia fuerte porque demuestra que un producto financiero open-source puede cerrar el ciclo completo de datos y distribución. Lo que más conviene estudiar no es su volumen de pantallas, sino cuatro decisiones: actividad canónica, proyecciones materializadas, sync observable y procedencia de datos.

Al mismo tiempo, sus issues abiertas son una advertencia útil: una arquitectura puede tener buenos objetos locales y aun así perder invariantes globales cuando proveedores, permisos, proyecciones y concurrencia crecen de manera transversal. La oportunidad no está en “alcanzar” a Sure copiando breadth, sino en construir un core con contratos más profundos, autorización no omisible, trazabilidad/replay y performance presupuestada desde el diseño.

