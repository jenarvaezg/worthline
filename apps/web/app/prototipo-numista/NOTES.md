# Prototipo #162 — UX de la colección de monedas (Numista)

**Desechable.** El _entregable_ de #162 es la dirección elegida, no este código.
Cuando se decida, se borra `apps/web/app/prototipo-numista/` y la dirección se
lleva a S2 (proyección/línea en Patrimonio) y S7 (detalle del catálogo).

## La pregunta

¿Qué pinta debe tener la colección Numista en sus **tres superficies**?

1. **Línea en Patrimonio** — el holding agregado «Colección Numista», una línea
   _ilíquida_ con valor _calculado_ (derivado de sus posiciones, ADR 0016).
2. **Detalle del catálogo** — las monedas individuales **agrupadas por metal**,
   con la valoración `max(metal, numismático)` por moneda (ADR 0017) y sus
   caídas (precio de compra → 0 + aviso).
3. **Conectar / sincronizar** — pegar credenciales (`client_credentials`,
   ADR 0016), botón de sincronizar, estado de «última sincronización».

## Cómo verlo

```
cd apps/web && npm run dev
# luego abre:
http://localhost:3000/prototipo-numista?variant=A
```

Salta entre variantes con la barra flotante inferior, o cambiando `?variant=`.
Solo en desarrollo (en producción redirige a `/patrimonio`). Datos 100 % mock.

Capturas de referencia (full-page, generadas con el Shell real):
`np-variant-A.png` · `np-variant-B.png` · `np-variant-C.png`.

## Las tres direcciones

| Var | Nombre              | Tesis                                                                                                                           | Afordancia principal |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| A   | Libro mayor         | La colección es **una fila más**; todo tablas, secciones de metal plegables con tablas de monedas dentro.                       | Escanear filas       |
| B   | Reparto por metal   | La colección es una **composición**: tira 100 % + ecualizador de barras altas descendentes; monedas plegadas como lista mínima. | Comparar tamaños     |
| C   | Galería numismática | Las monedas son **objetos**: rejilla de fichas por banda de metal, valor ganador vs perdedor tachado.                           | Ojear objetos        |

Gestalt del trío (la clave para que se distingan): **A = filas · B = barras · C = fichas**.
La B se rediseñó tras el primer pase (era un bento que recaía en una lista por
metal, casi idéntica a A). Se descartó el **donut** a propósito: chocaría con el
donut estrella del dashboard y, con datos tan sesgados (Oro ~82 %), una porción
del 0,2 % es invisible — el ecualizador descendente cuenta mejor la verdad.

Las tres comparten: la fila ilíquida con valor calculado, el agrupado por metal,
y el aviso «valor a 0» de la moneda sin estimación (visible en el riel superior).
Difieren en la jerarquía de información y en el tratamiento de la línea de
Patrimonio (nota de sync en texto · micro-barra apilada · puntos de metal).

## Veredicto

**Dirección elegida: B — «Reparto por metal».** (Jose, 2026-06-14: «me ENCANTA el B».)

**Por qué:** es un tercer gestalt genuino (A = filas · B = barras · C = fichas), así
que no se confunde con el resto del Patrimonio ni con una galería. La composición
(tira 100 % + ecualizador descendente) responde a «¿de qué está hecha la colección
y cuánto vale?» de un vistazo, y es el render más honesto de una colección sesgada
(Oro ~82 %), donde un donut escondería los metales pequeños y, además, chocaría con
el donut estrella del dashboard.

**Qué llevar a S2/S7 (decisiones de diseño que valida este prototipo):**

- **S2 — proyección / línea en Patrimonio:** una línea ilíquida «Colección Numista»
  con **valor calculado** (derivado, excluida de la Puesta al día), propiedad 100 %
  editable, y una **tira 100 % de reparto por metal** bajo el nombre como firma
  visual. El aviso «valor a 0» de una moneda sin estimación se enruta como el aviso
  existente (riel superior).
- **S7 — detalle del catálogo:** cabecera (total + nº monedas) → **tira 100 %
  apilada** → **ecualizador**: una barra alta por metal (orden descendente por
  valor) con % y subtotal+conteo en línea. Cada metal es un `<details>` **cerrado**
  por defecto; al abrir, **lista mínima sin cabecera** (nombre · grado · año · ×cant
  · valor + tag de base `metal/colección/compra/sin valor`). **Nunca** una tabla de
  columnas (eso es la variante A — fue lo que mató al primer diseño de B).
- **Conectar/sincronizar:** tile de fuente conectada (pill de estado + Sincronizar
  - stats Última sync/Monedas/Valor), credenciales plegadas en `<details>`.
- **Restricciones confirmadas:** todo server-rendered, cero JS (ADR 0009); tonos de
  metal **decorativos** (definir la paleta final en diseño — no reutilizar tokens
  semánticos; `--gold` sigue reservado a avisos); verde solo para el punto de estado
  «Conectado», nunca en cifras estáticas.

**Robado de las otras:** nada estructural. Se evaluaron A (ledger) y C (galería) y se
descartaron como dirección principal; el agrupado por metal y los tags de base de
valoración son comunes a las tres y sobreviven en B.
