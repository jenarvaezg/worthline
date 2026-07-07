# Propuesta B — «Panel de instrumentos»

Rediseño visual oscuro. Tesis: worthline es un **instrumento de medida** —
mide tu patrimonio como un altímetro mide altura. Superficies verde-carbón
profundas (no negro), la crema actual invertida como tinta, Iosevka como
protagonista absoluta, retícula de osciloscopio en las gráficas y una
**escala graduada** bajo la cifra héroe que sitúa tu patrimonio entre 0 y tu
número FIRE. Sobrio como un instrumento Braun: un dial, una aguja, ningún
neón.

Es una **inversión de polaridad**: mismo ADN (mismas fuentes, misma
semántica, misma gramática de gráficas), tema opuesto. Aprovecha los tokens
oscuros hoy huérfanos (`--ink-panel`, `--pos-on-dark`, `--neg-on-dark`, ver
`docs/design-system.md` §7). **No se despliega por páginas**: o toda la app
pasa al tema o nada — no hay estado intermedio digno. (Si se quiere
conservar el tema claro actual como alternativa, esto es exactamente el
«modo oscuro a un `prefers-color-scheme` de distancia» que la guía ya
anticipa; pero esta propuesta lo plantea como identidad por defecto, no como
modo.)

Leer primero: [00-analisis-visual.md](./00-analisis-visual.md) §3
(restricciones duras). Este documento asume esas restricciones.

## 1. Advertencia de estilo (leer antes de tocar nada)

El fracaso típico del tema oscuro financiero es «terminal hacker»: negro
puro + verde ácido + glow por todas partes. Esta propuesta es lo contrario:

- Fondo verde-carbón CÁLIDO, nunca `#000`.
- Los acentos brillantes (`--pos-on-dark`, `--neg-on-dark`) aparecen SOLO
  donde hoy aparece verde/rojo: deltas, P/L, banners. Un total nunca brilla.
- Un único elemento con luz propia por página (la escala del hero). Si al
  terminar algo más «brilla», sobra.

## 2. Tokens (`:root` de `globals.css`)

Los nombres NO cambian salvo los marcados «NUEVO». Solo cambian valores.

| Token                                                        | Hoy                   | Propuesta                   | Nota                                                                                                         |
| ------------------------------------------------------------ | --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--paper`                                                    | `#eef2ef`             | `#121815`                   | Fondo de app: verde-carbón profundo                                                                          |
| `--panel`                                                    | `#fffdf7`             | `#1d2724`                   | El viejo `--ink-panel` asciende a superficie estándar                                                        |
| `--ink`                                                      | `#17201e`             | `#e8ece7`                   | El viejo `--ink-panel-text`: crema como tinta                                                                |
| `--muted`                                                    | `#51605b`             | `#9fb0a9`                   | El viejo `--ink-panel-muted`. Re-testear 4.5:1 sobre `--paper` y `--panel`                                   |
| `--line` / `--line-strong`                                   | `#78877f` / `#5d6c66` | `#5f6e67` / `#7a8a82`       | Bordes de control: ahora el «strong» es el MÁS claro. Re-testear ≥3:1 sobre `--panel`                        |
| `--line-soft`                                                | `#d9ded7`             | `#2c3833`                   | Borde de tarjeta apenas visible                                                                              |
| `--hairline`                                                 | `#e4e8e2`             | `#26302b`                   |                                                                                                              |
| `--green`                                                    | `#006f5f`             | `#5ad4ae`                   | = viejo `--pos-on-dark`. Todo delta positivo hereda esto automáticamente                                     |
| `--red`                                                      | `#b9442f`             | `#f0907b`                   | = viejo `--neg-on-dark`                                                                                      |
| `--blue`                                                     | `#245177`             | `#7db3d9`                   | Interacción legible sobre oscuro. Re-testear 4.5:1                                                           |
| `--gold`                                                     | `#b3831f`             | `#d9a83f`                   | La «aguja ámbar» del instrumento: avisos y vivienda                                                          |
| `--tier-cash`→`--tier-housing`                               | verdes→azules→oro     | aclarar cada uno ~1.5 pasos | Misma familia y orden; deben leerse sobre `--panel` con ≥3:1 respecto al fondo de barra. Verificar uno a uno |
| `--radius` / `--radius-sm`                                   | `14px` / `8px`        | `10px` / `6px`              | Carcasa de instrumento: redondeado pero no blando                                                            |
| `--shadow`                                                   | 2 capas suaves        | `none`                      | En oscuro la elevación es LUZ: superficie más clara = más cerca (§3)                                         |
| `--panel-raised` NUEVO                                       | —                     | `#243029`                   | Superficie elevada (hero, hover de fila, popover)                                                            |
| `--tick` NUEVO                                               | —                     | `#3b4a43`                   | Marcas de graduación: escala del hero y retícula de gráficas                                                 |
| `--ink-panel`, `--ink-panel-text/muted`, `--pos/neg-on-dark` | definidos sin uso     | **eliminar**                | Sus valores ya viven en los tokens base; deja de existir la dualidad claro/oscuro                            |

Los deltas «on-dark» del hero y los chips heredan sin trabajo extra: ahora
toda la app es on-dark.

La cuadrícula del fondo actual se elimina del `--paper` (el fondo es liso);
la textura vive solo dentro de las gráficas como retícula (§6).

## 3. Superficies y elevación por luz

Tres alturas, codificadas por claridad — más claro = más cerca del usuario:

1. `--paper` (`#121815`): el fondo. Nada se dibuja directamente sobre él
   salvo el footer de persistencia y los títulos de página.
2. `--panel` (`#1d2724`): tarjeta estándar. `border: 1px solid
var(--line-soft)`, radio `--radius`, **sin sombra**.
3. `--panel-raised` (`#243029`): SOLO el hero, los popovers/tooltips y el
   hover de fila interactiva. Es la jerarquía que hoy hace el tinte verde.

El hero pierde el gradiente tintado: es `--panel-raised` liso con su
contenido. La distinción la hace la altura (claridad) + la escala graduada
(§4), no un tinte.

Regla para el implementador: prohibido introducir un cuarto gris. Si un
componente pide «un poco más de contraste», la respuesta es un borde
`--line`, no un fondo nuevo.

## 4. Signature: la escala graduada del hero

Bajo la cifra héroe, un SVG server-rendered de ancho completo del hero y
~28px de alto (aspecto fijo, ADR 0032):

```
291.604 €
├╌╌╌╌╌╌╌╌╌╌╌╌●╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
0          ▲ hoy    ⌂ coast          FIRE 750k
```

- Línea base y marcas menores en `--tick`; cada 10 % una marca mayor.
- El tramo 0→hoy se traza en `--ink` (recorrido hecho, luz serena — es el
  único elemento de la página con un trazo claro continuo).
- Marcador `hoy`: punto de 6px en `--ink`. Marcador `coast FIRE`: marca en
  `--gold` (la aguja ámbar). Extremo derecho: label pequeño «FIRE» +
  cifra en Iosevka.
- Labels en el nivel 3 tipográfico (0.7rem uppercase `--muted`).
- Datos: los mismos que ya consume la tarjeta FIRE de la home (% FIRE,
  número FIRE, coast requerido) — cero lógica nueva, solo presentación.
- La tarjeta FIRE de la home conserva su barra actual; la escala del hero
  es el eco protagonista de ese mismo dato.

Es la única pieza «de instrumento» explícita. No replicar el motivo de
escala en otras tarjetas.

## 5. Tipografía

- **Sin fuentes nuevas.** Source Sans 3 + Iosevka, como hoy. En oscuro, la
  crema sobre carbón ya da el carácter; añadir una display sería ruido.
- **Iosevka gana un rol**: los labels pequeños uppercase (nivel 3: stats,
  cabeceras de tabla, `h3`) pasan de Source Sans a **Iosevka 400 uppercase**
  con el mismo cuerpo y tracking. Es el rotulado serigrafiado del panel de
  un instrumento. `h2` y cuerpo siguen en Source Sans.
- Cifra héroe: mismo clamp, mismo peso. En oscuro conviene bajar UN punto la
  percepción de grosor: si al verla parece «engordada» por el halo claro
  sobre oscuro, usar 700 exacto (el peso físico del woff2) y compensar con
  `letter-spacing -0.01em`.
- Jerarquía de 3 niveles intacta.

## 6. Gráficas: retícula de osciloscopio

ADR 0032 intacto (barras discretas, SVG servidor, aspecto fijo). Cambios de
piel:

- **Retícula**: fondo del área de gráfica en `--paper` (más hundido que la
  tarjeta que la contiene), rejilla horizontal Y vertical en `--tick` con
  líneas cada división — la única cuadrícula de la app, y significa «zona de
  medida».
- **Barras**: relleno del color `--tier-*` aclarado al ~80 % de opacidad con
  el **remate superior de 2px sólido** al 100 % — la lectura (el valor) es
  el borde luminoso superior; el cuerpo es relleno. Deudas: mismo
  tratamiento en `--red`.
- **Línea de patrimonio neto**: `--ink` (crema) 1.5px con puntos en cierres
  mensuales. Es la traza principal del instrumento.
- **Donut de liquidez** (P4): mismo cambio que la propuesta A — vivienda y
  tiers ilíquidos con `<pattern>` rayado diagonal del propio color, líquido
  sólido; el patrón se repite en barras apiladas y barras-medidor de fila.
- **Sparklines** de drill-down: mismo remate superior sólido.

## 7. Componentes

- **Nav superior** (P2, P5): fila de texto Source Sans 650; la activa en
  `--ink` con un **LED de actividad**: punto de 4px `--green`… NO — verde es
  movimiento. La activa en `--ink` con subrayado 2px `--ink`; inactivas en
  `--muted`. Sin píldoras ni fondos. Móvil: una fila con scroll horizontal,
  nunca wrap; «Cerrar sesión» como texto al final.
- **Tabs de scope / Vista / rangos**: segmented control sobre `--panel` con
  borde `--line`; la activa se rellena de `--ink` (crema) con texto
  `--paper` — la inversión clásica, que en oscuro es muy legible. Radio
  `--radius-sm`.
- **Botones**: primario = crema (`--ink`) sobre oscuro con texto `--paper`,
  radio `--radius-sm`. Secundario = outline `--line-strong` texto `--ink`.
  «Crear objetivo» (P7): ancho natural alineado a la derecha, no bloque a
  ancho completo.
- **Formularios** (P7): inputs fondo `--paper` (hundidos: se escribe DENTRO
  del instrumento), borde `--line-strong`, radio `--radius-sm`; focus =
  borde `--blue` + outline. Texto `--ink`, placeholder `--muted`.
- **Chips de delta**: mismos contenidos; fondo translúcido del color del
  delta al 12 % + texto en `--green`/`--red` (que ahora son los brillantes).
  Radio `--radius-sm`.
- **Tablas** (P3): cabeceras en Iosevka uppercase (§5), hairlines `#26302b`,
  hover de fila `--panel-raised`. En /historico: (a) cierres de mes = fila
  con fondo `--panel-raised`, cifra 700 — sin chips; (b) separador de año =
  hairline doble con el año como label Iosevka; (c) tabla contenida a
  ~880px centrada dentro de su tarjeta.
- **Filas de holding en /patrimonio** (P6): nombres SIN subrayado, peso 650
  en `--ink`; la barra-medidor de fila se mantiene con los `--tier-*`
  aclarados. Kebab «···» sin círculo, glifo `--muted`, hover `--blue`.
- **Banners éxito/error y avisos**: texto/icono en `--green`/`--red`/
  `--gold` sobre fondo del color al 10 %. Nunca fondo sólido brillante.

## 8. Orden de aplicación (para el implementador)

1. Tokens §2 completos en un solo cambio (la app entera cambia de polaridad;
   a medio aplicar TODO se ve roto — no hacer commit intermedio).
2. Purga de huérfanos: eliminar `--ink-panel*`, `--pos/neg-on-dark` y todo
   uso residual; el hero pierde su gradiente (§3).
3. Elevación por luz §3 (`--panel-raised`, quitar `--shadow`).
4. Tipografía §5 (labels nivel 3 → Iosevka).
5. Componentes §7: nav → tabs → botones/forms → chips → tablas (/historico
   al final).
6. Gráficas §6 (retícula, remates, patrón rayado de vivienda).
7. Escala graduada del hero §4 (lo último: es la firma y merece la app ya
   estable debajo).
8. `contrast.test.ts`: re-declarar TODOS los pares (texto/fondo y
   borde/fondo cambian todos); correr gauntlet completo. Revisar
   `themeColor` en `layout.tsx` (hoy `#006f5f`) → `#121815`.

## 9. Checklist de verificación (comparar contra capturas)

- [ ] Ningún `#000` ni gris neutro: todos los fondos en la familia
      verde-carbón (`#121815`/`#1d2724`/`#243029`) y nada más.
- [ ] Cero sombras; la elevación se lee por claridad de superficie.
- [ ] `--green`/`--red` brillantes aparecen SOLO en deltas, P/L y banners.
- [ ] La escala graduada existe solo en el hero de la home.
- [ ] Labels uppercase en Iosevka; h2/cuerpo en Source Sans.
- [ ] Retícula solo dentro de gráficas; fondo de app liso.
- [ ] /historico sin chips oscuros; cierres como filas elevadas.
- [ ] Móvil: nav en una fila con scroll, sin wrap.
- [ ] Donut/barras: vivienda rayada, líquido sólido.
- [ ] `contrast.test.ts` re-declarado y verde; gauntlet verde; `themeColor`
      actualizado.
