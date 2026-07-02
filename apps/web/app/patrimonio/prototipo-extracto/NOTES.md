# Prototipo extracto multi-ISIN

## Decisiones tomadas

- Ruta aislada en `apps/web/app/patrimonio/prototipo-extracto/`; no toca rutas de producción ni acciones de importación reales.
- La tabla usa densidad compacta: una fila por ISIN, importes y participaciones alineados a la derecha, y el detalle de merge dentro de un `<details>` en la última columna.
- El bucket "Encaja" representa una inversión existente por ISIN; el bucket "Nuevo" representa creación con búsqueda FAKE de ISIN; el bucket "Ignorado" representa exclusión explícita del usuario.
- Un lookup sin resolver se lee como fila nueva desmarcada por defecto, con nombre y símbolo vacíos. Puede incluirse, pero el resumen avisa que nacería con `MISSING_PROVIDER_SYMBOL`.
- El resumen de confirmación se calcula sobre checkboxes locales: fondos incluidos, operaciones ejecutadas, nuevos holdings y total. Es un prototipo sin mutación.
- El fixture es sintético: forma MyInvestor Órdenes, columnas separadas por `;`, fechas `dd/mm/yyyy`, decimales con coma y saltos CRLF.

## Preguntas abiertas

- Si una fila no ejecutada vive dentro de un ISIN incluido, conviene decidir si el conteo visible debe llamarla "saltada" o reservar "ignorado" solo para fondos excluidos.
- En S1/S2 habrá que decidir si nombre y símbolo se editan inline en esta tabla o si se abre la ficha mínima del wizard para cada fondo nuevo.
- Falta validar la microcopia exacta del aviso `MISSING_PROVIDER_SYMBOL` cuando el usuario confirma un fondo sin símbolo.
