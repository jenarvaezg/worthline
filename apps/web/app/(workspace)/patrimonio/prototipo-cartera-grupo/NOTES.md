# Prototipo — la cartera gestionada en la lista (#1548)

**Pregunta:** ¿cómo se pinta una cartera gestionada en la lista unificada de
/patrimonio, de modo que colapsada sea **un sumando**, expandida sea **un
desglose**, y en ningún eje de agrupación se desmiembre?

Cuatro variantes en la misma ruta, conmutables con `?variant=a|b|c|d` (barra
flotante o flechas ← →). Dos controles más, porque la pregunta no se puede
juzgar sin ellos:

- `?eje=direction|rung|instrument` — los tres ejes de `portfolio-grouping.ts`.
- `?bucket=own|dominant` — en el eje Instrumento, ¿la cartera es un instrumento
  propio («Cartera gestionada») o hereda el dominante de sus miembros («Fondo»)?

La tira de estado de la cabecera enseña, tras cada acción: Σ sumandos, bruto del
fixture, si el invariante cuadra, en qué bucket cae la Metal, si está colapsada
o expandida y la deriva contra el testigo de S4.

## Cómo se abre

```
bun dev   →   http://localhost:3000/patrimonio/prototipo-cartera-grupo
```

La ruta devuelve 404 en producción (`NODE_ENV === "production"`).

## Veredicto (Jose, 23-08)

**Gana la mezcla, `?variant=e`** — y es la que abre por defecto:

- la **fila y el raíl de A** (la cartera es una fila más, los hijos se indentan),
- el **chip «CARTERA» de C** (dice lo que la fila es sin gastar palabras),
- las **divisiones de B**: la barra de peso de la fila se divide en segmentos,
  uno por miembro, así que el reparto se lee sin desplegar.

La barra de la fila conserva su único significado de siempre (cuánto pesa esta
fila en su sección) y solo gana textura por dentro. Al desplegar, una segunda
barra reescala ese mismo reparto al 100 % de la cartera, que es la escala en la
que los porcentajes de los hijos se comprueban con el ojo. **Duda para la
implementación:** si esa segunda barra sobra, o si al revés debería sustituir a
los porcentajes de las filas hijas.

**Decidido también (Jose, 23-08):** en el eje Instrumento la cartera **hereda el
instrumento dominante («Fondo»)** — nada de bucket propio. `?bucket=` sigue en el
prototipo para ver la alternativa, pero el defecto ya es `dominant`.

**Pega medida de E, sin resolver en el prototipo:** con el eje Activos/Pasivos la
barra de la fila mide **2,91 px** y los 8 segmentos —solo con sus separadores de
1 px— suman **8 px**: se recortan y se ven tres, los tres primeros por orden y no
por peso. No es un suelo mal puesto, es que las divisiones no caben. Al
implementarlo, los cortes deben pintarse con un `linear-gradient` de paradas duras
en vez de hijos con borde: a 3 px degrada solo al color dominante, sin recorte y
sin mentir.

A, B, C y D se quedan en la rama como fuente primaria de por qué E es lo que es.

## Las variantes

| | Qué propone | Apuesta | Coste |
|---|---|---|---|
| **A** Subsección con jerarquía | La cartera es una fila igual que las demás, con triángulo; los miembros se indentan bajo un raíl, sin barra (no son sumandos) | La jerarquía se entiende sola con indentación | El desglose es texto plano: no dice nada de la composición |
| **B** Mini-panel anidado | Un panel dentro del panel, con su **barra de composición propia visible aun cerrada** | Lo que importa de una gestionada es el reparto, no la lista | Rompe el ritmo de filas: mete un objeto con marco en la lista |
| **C** Fila opaca + cajón | La cartera es una fila normal con un chip; el desglose se abre en un cajón a ancho completo bajo el tablero | Σ filas = bruto se defiende solo si una cartera es SIEMPRE una fila | Renuncia a la jerarquía en la lista; el desglose vive lejos |
| **D** Sección propia sobre los ejes | Las carteras salen del eje y se agrupan en cabeza del panel; el desglose son fichas de peso | Elimina la pregunta «¿en qué bucket cae la Metal?» | El eje deja de ser exhaustivo |
| **E** La mezcla ★ | A + chip de C + barra de fila dividida por miembros (B) | La lista sigue siendo filas homogéneas y aun así se lee el reparto | Con la cartera pesando poco en su sección, las divisiones se pierden |

## Fixture

La **Cartera Indexada Metal** de Jorge con las cifras worthline reales medidas el
19-08 (comentario de fixture en #1399): 7 fondos + efectivo del contenedor
7,34 € → derivado **1.517,57 €**, testigo declarado 1.497,37 € (21-08), deriva
1,35 % (por debajo del umbral del 2 % de S4, #1550). Los vecinos —cuenta
corriente, dos fondos sueltos, plan de pensiones, vivienda e hipoteca— son
plausibles-sintéticos y existen solo para dar densidad: sin vecinos, cualquier
variante se ve bien.

No incluye la posición cerrada de 0 € con el mismo ISIN que el Vanguard de dentro
de la Metal (el tablero real la pliega en «Posiciones cerradas»); el miembro de
dentro lleva la nota que lo recuerda.

## Lo que el prototipo ya deja ver

- Con el eje **Activos/Pasivos** la Metal es una hairline: 1.517 € contra una
  vivienda de 185.000 €, con las barras escaladas a la sección. Cualquier variante
  que apueste por la barra de la cabecera para comunicar «esto es un bloque» se
  cae ahí. B y D no dependen de esa barra.
- El eje **Instrumento** con `bucket=own` crea una sección de un solo elemento
  («Cartera gestionada» → la Metal), que en la variante D duplica visualmente la
  sección hoisted. Con `bucket=dominant` la Metal cae en «Fondo» junto a los
  fondos sueltos — que es exactamente lo que #1548 quiere evitar que ocurra con
  sus miembros, pero para el bloque entero puede ser correcto.
- El efectivo del contenedor (7,34 €, escalón Caja) es el único miembro que no es
  Mercado: en el eje Liquidez, si la cartera se clasifica por su escalón dominante,
  ese efectivo desaparece del escalón Caja. Es una decisión, no un bug — pero hay
  que tomarla explícitamente.

- En **D**, con el eje Activos/Pasivos, lo que queda tras sacar las carteras se
  sigue titulando «Activos» debajo de «Carteras gestionadas», y se lee raro: si
  D gana, esa sección residual necesita nombre propio («Resto», o ninguno).

- **C no funciona sin acompañamiento**: el cajón nace al pie del tablero, así que
  con una lista de altura normal el botón «desglose» parece muerto — el cajón se
  abre fuera de la vista. La variante solo es honesta llevando la vista al cajón
  al abrirlo y dejando la fila marcada mientras dura. Si C gana, eso es parte de
  lo que hay que implementar, no un detalle.

## Preguntas abiertas para el veredicto

1. ¿Colapsada por defecto o expandida por defecto? (Aquí arranca colapsada.)
2. ¿El estado de plegado va a la URL (`pushState`, interaction-patterns) o es
   memoria del cliente? Con varias carteras, ¿una clave por cartera?
3. Si se elige B: ¿la barra de composición se pinta con la escala de color del
   escalón (como aquí) o con la paleta categórica de `dataviz`?
4. ¿Qué hace la cabecera con la rentabilidad de S6 (#1552) — cabe en la fila o
   solo en la ficha?
