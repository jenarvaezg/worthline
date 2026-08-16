# Prototipo: qué forma tiene `/ajustes/conexiones` (#1223)

> **Decisión:** [#1223](https://github.com/jenarvaezg/worthline/issues/1223) (S1 del
> PRD [#1222](https://github.com/jenarvaezg/worthline/issues/1222)) · fuente primaria
> en la rama desechable `prototipo/1223-conexiones` (no se mergea).

## Pregunta

El registry de UI resuelve el «cero JSX por fuente», pero no dice **qué forma
tiene la página**: qué se ve de un vistazo, dónde cae la salud del sync (S2
#1224), dónde se editan las credenciales (S3 #1225) y cómo aguanta la lista
cuando haya más de dos fuentes.

## Variantes evaluadas

Tres maquetas sobre el mismo dato, en `/ajustes/prototipo-conexiones?variant=A|B|C`
(404 en producción), con fixtures que enseñaban a la vez estados que el workspace
real no junta: error persistente, sincronizando, sin conectar y dos fuentes
inventadas.

| Clave | Nombre              | Afordancia primaria | Veredicto                                        |
| ----- | ------------------- | ------------------- | ------------------------------------------------ |
| **A** | Libro de conexiones | la **fila**         | **Sí** — validada en local por Jose               |
| B     | Índice + ficha      | la **fuente**       | No — master-detail sobra con dos fuentes          |
| C     | Salud primero       | la **corrida**      | No — asume que solo se entra cuando algo va mal   |

## Decisión: **A, «Libro de conexiones»**

- La página es una **tabla**, no una rejilla de tarjetas ni un master-detail.
- Todo lo accionable ocurre **sin navegar**: el pliegue bajo la MISMA fila es el
  detalle. En S1 solo lleva la desconexión; el historial de corridas (S2) y las
  credenciales editables (S3) entran ahí sin mover la fila.
- Las fuentes sin conectar viven en una lista aparte al pie, cada una con su
  pliegue «Conectar».
- La banda de **premium pausado** va en la cabecera de la página, no por
  conexión: el plan es del workspace entero.

Único arreglo pedido sobre la maqueta: las cabeceras de columna numérica
(«Elementos», «Valor») iban alineadas a la izquierda sobre columnas alineadas a
la derecha.

## Lo que el prototipo NO resolvió

- Si la fila «sincronizando» debe refrescarse sola (poll) o basta con recargar.
  Queda para S2, que es quien trae el estado de la corrida.
- A dónde apunta «Ver →» cuando la fuente materializa varios rungs (Binance:
  mercado + bloqueado a plazo). S1 mantiene el comportamiento previo: la ficha
  del activo espejo.
