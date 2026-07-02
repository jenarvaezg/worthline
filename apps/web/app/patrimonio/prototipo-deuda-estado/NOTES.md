# Prototipo deuda por estado actual

## Decisiones tomadas

- Orden del formulario: saldo pendiente hoy -> fecha de fin -> selector "Dato del banco" -> campo variable. La pantalla empieza por la verdad que re-baselinea la deuda y solo después pide el dato que permite proyectar.
- Toggle: "Tengo el tipo anual" / "Tengo la cuota mensual". Evita hablar de modo o método; el usuario elige lo que ve en el banco.
- Cheque de honestidad: si se introduce tipo anual, la cuota calculada domina; si se introduce cuota, domina el tipo anual equivalente. En ambos casos la pregunta es si cuadra con el banco.
- Pasado no modelado: se comunica como una mini linea temporal en el resumen, no como ayuda larga bajo cada campo. "Antes de hoy" queda explícitamente sin saldos inventados; "Desde hoy" usa plan amortizado.
- El prototipo fija "hoy" en 2026-07-02 para que la revisión sea estable. Producción debe usar la fecha real de la baseline.

## Preguntas abiertas

- Fecha de próxima cuota: el S0 usa meses restantes redondeados desde hoy hasta la fecha de fin. S1 debería decidir si la pantalla pide tambien el día de cobro o si lo deriva de la primera cuota confirmada.
- Firma original: parece mejor como dato descriptivo posterior o dentro de detalles avanzados; no debe competir con saldo, fin y cuota/tipo.
- Recalibración de una deuda existente: el mismo patrón sirve, pero la cabecera debería decir "Recalibrar con saldo real" y mostrar el saldo modelado actual junto al saldo del banco.
