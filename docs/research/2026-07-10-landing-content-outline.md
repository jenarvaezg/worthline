# Landing pública — content outline «Evoluciona tu Excel»

> Asset del ticket [#860](https://github.com/jenarvaezg/worthline/issues/860) (mapa wayfinder [#856](https://github.com/jenarvaezg/worthline/issues/856)). Grilling con Jose 2026-07-10. Insumos: matriz de claims (`2026-07-10-landing-claims-audit.md`) y research de posicionamiento (`2026-07-10-posicionamiento-trackers-landing.md`). Es el outline para prototipar (#862) — no la spec final (esa la compila #858).

## Reglas heredadas (no renegociables aquí)

- Presente de indicativo solo para lo shipped (matriz #859); adjuntos/ingesta/pool jamás como capacidad.
- Capturas: solo producto real con datos de demo; shot list final espera a «Libro mayor» (#825).
- Proteger el matiz «en una sola **imagen**» — nunca degradar a «sitio/plataforma» (quemado por 4 competidores).
- Tono editorial; la IA no dicta ni la estética ni la promesa central.
- Evitar: «conecta todos tus bancos», «tiempo real», «optimiza/hazte más rico», fiscal, «gratis».

## Arco (9 secciones, valor antes que mecánica)

### 1 · Hero

```
Evoluciona tu Excel.

Todo tu patrimonio — activos, deudas, retornos reales, FIRE —
por fin en una sola imagen. Cerrada, auditable y tuya.

[ Empezar con mis datos ]   [ Explorar la demo ]
```

El posicionamiento rector como H1 (territorio virgen: nadie ocupa el punto medio entre «ditch the spreadsheet» y encerrarte en la hoja). El subcopy aterriza el qué y adelanta control («cerrada, auditable y tuya»).

### 2 · Prueba visual — la imagen única

Captura real (demo) de la home a lo ancho: hero de cifra, composición, deudas. Es la demostración inmediata del subcopy. Pie con enlace discreto «Velo en la demo».

### 3 · De tu Excel a worthline (sección firma)

Artefacto: **correspondencia hoja→producto** — respetuosa, sin Excel feo de por medio (no somos «ditch the spreadsheet»):

```
DE TU HOJA…                …A WORTHLINE

Una fila por activo      → Posiciones con precio y retorno real (IRR/TWR)
La pestaña de deudas     → Deudas con su cuadro y proyección
Fórmulas que un día      → Un motor que calcula — y explica — cada cifra
se rompen
Guardar como v2-final    → Histórico cerrado: cada mes, congelado y auditable
Tú tecleando precios     → Precios y fuentes que se actualizan solos
```

### 4 · Lo que tu Excel no podía (profundidad inversora)

Titular: **«¿Está funcionando de verdad tu cartera?»**. Cuatro pruebas con captura, mismo peso — FIRE presente sin volver la landing nicho:

1. IRR y TWR reales por posición
2. Cobros: dividendos, intereses, rentas
3. Exposición real: geografía/divisa look-through
4. Proyección FIRE y objetivos con fecha

### 5 · Actualizar sin dolor (mecánica)

Import de extracto con preview y confirmación · fuentes conectadas (Binance, Numista) · precios que se actualizan solos con cadencia honesta. Lenguaje shipped-only: «tu extracto CSV/Excel», nunca «cualquier broker».

### 6 · Control y trazabilidad

Titular: **«Tus cifras, cerradas y tuyas.»** (la propiedad manda; el contrarian es un punto, no el titular):

```
• Cada mes se cierra y se congela — nada se recalcula a tus
  espaldas; toda corrección queda auditada.
• Export completo en JSON y tu workspace en su propia base de datos.
• Sin conectar tu banco. A propósito: tus credenciales bancarias
  no viven aquí — tú decides qué entra, con preview.
```

### 7 · IA contenida

Titular: **«Habla con tu patrimonio. Y que te responda con la cifra exacta.»**
Captura real del chat respondiendo (p. ej. «¿cuánto cobré en dividendos en 2025?») con cifra y fuente. Remate:

```
El asistente solo lee: responde con tus datos reales y cita de
dónde sale cada cifra. Jamás escribe ni «estima» nada.
```

Ni una palabra de adjuntos/ingesta (decidido, sin código).

### 8 · Avanzado: MCP

Sección corta marcada **«PARA USUARIOS AVANZADOS»**. Titular: **«Tu patrimonio, leíble por tu agente.»**

```
Conecta Claude — o cualquier cliente MCP — a tus datos con OAuth:
contexto financiero, histórico, retornos, cobros, calidad de datos.

Lectura completa. Escritura: ninguna. Por diseño.
```

### 9 · Cierre

```
Tu Excel ya hizo su trabajo.

Trae tu foto de hoy en unos minutos — sin fórmulas, con preview
en cada paso. Y si un día quieres irte, tus datos salen contigo
en un JSON.

[ Empezar con mis datos ]   [ Explorar la demo ]
```

## Coreografía de CTAs

Serena, coherente con el tono editorial: botones solo en hero (1) y cierre (9); cada captura (secciones 2–8) lleva en el pie un enlace discreto «Velo en la demo». Sin sticky bars ni CTAs intermedios.

## Para el prototipo (#862)

- Las capturas provisionales pueden salir de la home actual/demo; el shot list definitivo espera a «Libro mayor».
- Decidir allí si alguna transición/animación explica mejor la sección 3 (siempre con `prefers-reduced-motion`).
- El copy de este outline es concreto pero no final: la spec (#858) lo consolida tras prototipo, arquitectura (#861) y aceptación (#863).
