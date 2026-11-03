# Histórico completo de un plan de pensiones de MyInvestor

- **Fecha de verificación:** 2026-11-03
- **Pregunta (#1872):** ¿qué fuente da el histórico completo de un plan de pensiones de
  MyInvestor, para que el conector (#1863, #1869 P2) lo traiga entero al conectar?
- **Método:** fuentes primarias, en este orden:
  1. el bundle público de la web (`https://newapp.myinvestor.es/assets/*.js`, 744 chunks
     descargados el 2026-11-03);
  2. el cliente de referencia `myinvestor-cli` (`src/myinvestor/client.py`, issues #69, #70 y #73,
     PR #79);
  3. lecturas GET contra la cuenta real de Jose con la sesión del CLI (`--no-signature`,
     `--min-interval 3`).

  En total fueron 14 peticiones, todas con 200. Ninguna pidió firma ni SMS y no hubo bloqueo de
  Imperva. Las respuestas crudas están en `.local/research-1872/`, fuera de git.
- **Repo público:** abajo solo aparecen rutas, parámetros, número de filas y años. No hay importes
  ni identificadores.

---

## Resumen

**La API da el histórico completo de un plan. No hace falta reserva.**

| Qué | Endpoint y parámetros | Verificado |
|---|---|---|
| Órdenes (aportaciones, movilizaciones) | `GET /cperf-server/api/v2/pension-accounts/{id}/orders?dateFrom=AAAAMMDD&dateTo=AAAAMMDD` | 37 órdenes de 2024 a 2026, desde la apertura. Sin fechas devuelve 2. |
| Serie diaria (valor, participaciones, coste medio) | `GET /cperf-server/api/v2/pension-accounts/{id}/positions?groupType=SINCE_BEGINNING` | Desde 2024, el inicio del plan. |

- Con las órdenes `COMPLETE` se reconstruyen **exactamente** las participaciones de hoy de los dos
  planes de la cuenta.
- La primera orden es la movilización externa de entrada de 2024. Es la apertura.

La reserva de #1869 P2 (dueño desde donde alcanza la ventana, más un careo en la costura) **no hace
falta para los planes**.

---

## 1. Órdenes de un plan: `dateFrom`/`dateTo` en `AAAAMMDD`

### Lo que hace la web

En la pantalla «Órdenes» del plan (chunks `PensionPlanOrders-*.js` y `PensionPlan-*.js`), el hook
`yEe` de `api-CH3sVNR9.js` construye la query así:

```js
let {dateRange:n,...r}=t??{},
    {from:i,to:a}=(n&&nq({dateRange:n,format:`yyyymmdd`}))??{},
    o={...r,dateFrom:i,dateTo:a};
return Y(qA(j(e),{query:o}))   // qA = GET `${J}/api/v2/pension-accounts/${e}/orders`
```

Los parámetros que acepta la pantalla salen de su formulario de filtros:

- `dateFrom` y `dateTo` en `yyyymmdd`, sin guiones (el CLI manda ISO en valores; aquí no);
- `dgsCode`, para filtrar un plan;
- `type`: `PERIODIC` u `ORDINARY`;
- `status`: `PENDING`, `IN_PROGRESS`, `CANCEL`, `REJECTED` o `COMPLETE`;
- `amountFrom` y `amountTo`.

El aviso de órdenes pendientes de la cuenta (`PensionPlans-*.js`) llama con `{order: "DATE"}` y sin
fechas. Esa es la llamada que devuelve solo las recientes.

Tampoco hay más mínimo que el que elija el usuario: el selector de fechas
(`Filters-aagWln1Y.js`) tiene atajos de 15 días, 30 días, 6 meses y 12 meses, y un «desde» libre
sin `min`.

### Lo que responde la API (cuenta real, una cuenta de pensiones con dos planes)

| Petición | Filas |
|---|---|
| `orders?order=DATE` (sin fechas) | 2 |
| `orders?order=DATE&dateFrom=20000101&dateTo=20261103` | **37**, de 2024 a 2026 |
| `myinvestor orders --pension --all` (CLI con el arreglo de #79) | 37 |

- **Sin paginación.** La respuesta trae solo `{status, payload: {data: [...]}}`, sin bloque
  `pagination`, y las 37 llegan en una página.
- **Validación por participaciones.** Se suman las `shares` de las órdenes `COMPLETE`: en positivo
  las altas y las aportaciones, en negativo las bajas por movilización. El resultado coincide al
  diezmilésimo con las `shares` actuales de **los dos** planes
  (`GET /v2/pension-accounts/{id}`).
- **Contenido de las 37 órdenes:**
  - `operationType`: `PLAN_CONTRIBUTION` ×32, `REGISTRATION_BY_EXTERNAL_PLAN_TRANSFER` ×3,
    `REGISTRATION_BY_INTERNAL_PLAN_TRANSFER` ×1 y `DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER` ×1.
  - `status`: `COMPLETE` ×33, `REJECTED` ×3 e `IN_PROGRESS` ×1. Las que no están `COMPLETE` vienen
    sin `shares`: al libro solo entra lo `COMPLETE`, como dice #1869 P4.
  - Las aportaciones periódicas llegan como `orderType: ORDINARY`, igual que las sueltas. El filtro
    `type=PERIODIC` no sirve para distinguirlas.
- **Claves de cada fila:** `amountBuyVL`, `amountToBlock`, `cash`, `codAccount`, `currency`,
  `dgsCode`, `effectiveDate`, `fundName`, `isCancelable`, `market`, `operationType`, `orderDate`,
  `orderType`, `pensionAccountId`, `productType`, `reference`, `shares`, `status` y `ticker`.

Con esto queda resuelto el hueco de myinvestor-cli#69. El arreglo ya estaba en el PR #79, sin
probar contra la API; esta investigación lo verifica.

## 2. Serie histórica del plan: `groupType=SINCE_BEGINNING`

- El CLI solo conocía `ONE_MONTH`, `THREE_MONTHS`, `SIX_MONTHS` y `ONE_YEAR`
  (`client.Period`); su comentario dice que `MAX` responde 400.
- La web traduce sus periodos con la tabla `Tg` de `api-CH3sVNR9.js`:

```js
Tg={ONE_MONTH:`ONE_MONTH`, THREE_MONTHS:`THREE_MONTHS`, SIX_MONTHS:`SIX_MONTHS`,
    YEAR_TO_DATE:`YTD`, ONE_YEAR:`ONE_YEAR`, ALL:`SINCE_BEGINNING`}
```

Esa misma tabla la usan la gráfica de planes (`n8`, que llama a `KA` = `GET .../pension-accounts/{id}/positions`) y la de cuentas de valores (`O3`).

`GET /cperf-server/api/v2/pension-accounts/{id}/positions?groupType=SINCE_BEGINNING` responde 200.
La serie de cada plan empieza el día de su alta:

| Plan | Puntos | Desde | Paso |
|---|---|---|---|
| Plan abierto por movilización externa | 379 | 2024 | Semanal en lo antiguo, diario en el último año |
| Plan destino de la movilización interna | 128 | 2026 | Diario |

Cada punto trae `date`, `totalShares`, `avgPositionCost`, `marketValue`, `currencyMarketValue`,
`investmentAddedValue` y `returnValue`. Sirve de testigo. Las operaciones salen de las órdenes,
y precio y coste los pone worthline (#1869 P1 y P7). Ojo: `investmentAddedValue` y
`avgPositionCost` arrastran el «invertido» de MyInvestor, que tras un traspaso no es el coste
heredado (myinvestor-cli#73).

Sin verificar: que `SINCE_BEGINNING` funcione también en
`/v2/securities-accounts/{id}/positions`. La web lo usa ahí, pero esta investigación no lo probó.

## 3. Plan B, los documentos: no hace falta y no daría las operaciones

- `GET /cperf-server/api/v2/pension-accounts/self/documents` devuelve 3 documentos, todos el
  **boletín de adhesión** de un plan (el nombre del PDF lleva su código DGS). No hay extractos.
- `GET /cperf-server/api/v2/customers/self/documents/fiscal` devuelve la «Información fiscal» de
  2024 y de 2025, una por año. Es un resumen anual, no una lista de operaciones fechadas. No se
  descargó.
- Ninguno trae las aportaciones fechadas, y las órdenes ya las dan. El lector de PDF de MyInvestor
  (#1793) no tiene que cubrir planes.

## 4. Movilizaciones entre planes

### Internas (los dos planes en MyInvestor)

Aparecen en `orders` como **dos órdenes**:

- `DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER` en el plan de origen: salen participaciones. La API
  da `shares` en positivo y la web le pone el signo (conjunto `V` de `PensionPlanOrders-*.js`).
- `REGISTRATION_BY_INTERNAL_PLAN_TRANSFER` en el plan de destino: entran participaciones.

Lo que comparten y lo que no (comprobado en el par real y en el detalle
`GET .../orders/{reference}` de cada pata):

- **Comparten:** misma cuenta de pensiones, mismo `orderDate`, mismo `effectiveDate` y el mismo
  `cash`, `grossAmountEUR` y neto de la ejecución.
- **Difieren:** el `dgsCode`, las `shares` (cada plan tiene su valor liquidativo) y la `reference`.
- **No hay id común.** Ni la fila ni el detalle (`orderReference`, `relatedOperations[].operationNumber`)
  trae un `transferId` compartido.
- `GET .../pension-accounts/{id}/transfers?initDate=2000-01-01&endDate=2026-11-03` devuelve
  **0 filas**, igual que en myinvestor-cli#70. La web solo lo pide para los últimos 60 días
  (`xEe`) y no sirve para emparejar lo antiguo.

**Se pueden emparejar** con una clave sintética: (cuenta de pensiones, `orderDate`, `cash`, tipo
`DEREGISTRATION_BY_INTERNAL_*` ↔ `REGISTRATION_BY_INTERNAL_*`, `dgsCode` distinto). El conector
genera el `transferId` del par `transfer_out`/`transfer_in` y el coste viaja desde el origen
(ADR 0082), igual que en los traspasos de valores. Si un día aparecen dos pares con la misma fecha
e importe, se desempata por `effectiveDate` y, si sigue el empate, por las participaciones de
destino frente a las de origen × la proporción de VL del día. En la cuenta real no pasa.

La web reconoce más tipos de movilización: `REGISTRATION_BY_PLAN_IN_PROGRESS_TRANSFER`,
`*_TRANSFER_PLANS_INTERNAL_FROM`, `*_TRANSFER_PLANS_EXTERNAL_FROM`, y
`ENTRY_`/`EXIT_TRANSFER_PLANS_INITIAL_MANAGER` (conjuntos `V` y `H` de `PensionPlanOrders-*.js`).
La cuenta real no los tiene, pero el emparejador y el signo deben aceptarlos.

### Externas (de o hacia otra gestora)

- Entra como una sola orden, `REGISTRATION_BY_EXTERNAL_PLAN_TRANSFER`, con `orderTypeName`
  «ALTA POR TRASPASO PLAN EXTERNO».
- El detalle no trae la gestora de origen ni el coste heredado.
- Encaja con #1869 P1: en un traspaso externo que entra se pregunta el coste heredado.
- En la cuenta real hay 3 de 2024: 2 `COMPLETE` y 1 `REJECTED` sin participaciones.

---

## Consecuencias para el conector (#1870)

1. **Arranque:** `orders?dateFrom=20000101&dateTo={hoy}` por cuenta de pensiones (en `AAAAMMDD`).
   Cada sincronización posterior pide una ventana corta con las mismas fechas.
2. **Verificación P8:** las participaciones reconstruidas desde las órdenes `COMPLETE` cuadran
   exactas con `shares` de `GET /v2/pension-accounts/{id}`. Comprobado en la cuenta real.
3. **Movilizaciones internas:** se emparejan con la clave sintética de la sección 4. Las externas
   entran como alta y piden el coste heredado.
4. **Planes:** la reserva de P2 no hace falta. Puede quedarse como red para cuentas en las que la
   API no cuadre, con la señal de P8.

## Lo que no se verificó

- Cuentas con más de una cuenta de pensiones, o con planes de antes de 2024. Solo hubo una cuenta,
  abierta en 2024.
- Un tope de filas o de rango por petición: 37 filas en una respuesta, sin bloque de paginación.
- Las movilizaciones **de salida** a otra gestora y los tipos `*_FROM` / `*_INITIAL_MANAGER`. No
  existen en la cuenta.
- `SINCE_BEGINNING` en cuentas de valores.
