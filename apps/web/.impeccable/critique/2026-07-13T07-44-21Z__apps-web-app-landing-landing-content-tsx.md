---
target: apps/web/app/landing/landing-content.tsx
total_score: 28
p0_count: 0
p1_count: 3
timestamp: 2026-07-13T07-44-21Z
slug: apps-web-app-landing-landing-content-tsx
---
Method: dual-agent (A: /root/critique_a_design · B: /root/critique_b_evidence)

# Crítica de `apps/web/app/landing/landing-content.tsx`

## Design Health Score

| # | Heurística | Puntuación | Problema clave |
|---|---|---:|---|
| 1 | Visibilidad del estado del sistema | 3/4 | La sesión comunica su resultado, pero los reveals pueden dejar capítulos aparentemente vacíos hasta entrar en viewport. |
| 2 | Correspondencia sistema / mundo real | 3/4 | El libro mayor encaja con el modelo mental; FIRE, IRR, TWR, look-through, MCP, OAuth y JSON aparecen sin definición. |
| 3 | Control y libertad | 3/4 | Hay rutas claras a registro, demo y login; falta acceso rápido a confianza/seguridad en una página muy larga. |
| 4 | Consistencia y estándares | 4/4 | Tipografía, color, reglas, cifras tabulares y componentes forman un sistema excepcionalmente cohesivo. |
| 5 | Prevención de errores | 3/4 | Preview, confirmación, solo lectura y exportación prometen buenas salvaguardas, aunque la landing todavía no aporta evidencia completa. |
| 6 | Reconocer antes que recordar | 3/4 | Las mini-pruebas hacen visibles los claims; el vocabulario experto exige traducción mental. |
| 7 | Flexibilidad y eficiencia | 3/4 | Registro, demo y login son accesibles; faltan atajos para quien busca precio, privacidad o seguridad. |
| 8 | Diseño estético y minimalista | 3/4 | La composición es disciplinada, pero el tramo central repite demasiado “label + Asiento + regla + h2”. |
| 9 | Reconocer, diagnosticar y recuperarse de errores | 2/4 | El fallo de sesión degrada silenciosamente a “Entrar”; no hay otros estados de error observables en esta superficie. |
| 10 | Ayuda y documentación | 1/4 | La demo ayuda, pero faltan FAQ, precio, privacidad, condiciones, seguridad y contacto. |
| **Total** |  | **28/40** | **Buena: base sólida, con brechas importantes de confianza y robustez.** |

## Anti-Patterns Verdict

### ¿Parece generado por IA?

**Evaluación LLM:** no al primer vistazo. La hoja con cifras reales, el banding, las reglas contables y la doble superficie cubierta/papel construyen un objeto específico, no una landing SaaS genérica. La combinación verde oscuro + oro + serif sí es previsible en wealth management, pero la semántica material evita el cliché superficial.

El segundo orden falla parcialmente. Al rechazar neobanco, terminal cripto y clon de Excel, la solución cae en otra familia saturada: editorial tipográfica con serif, mono, microetiquetas uppercase, reglas y capítulos numerados. Los cinco “Asientos” consecutivos convierten la identidad aprobada en scaffold uniforme. No hay que cambiar la identidad; hay que evitar que toda idea use exactamente la misma puesta en escena.

**Escaneo determinista:** un único intento sobre el target devolvió `[]`: 0 hallazgos, 0 reglas y 0 ubicaciones. Es un resultado válido pero estrecho. No detecta el fallo más importante porque este vive en `landing.module.css:760-769` y en la orquestación de `IntersectionObserver`, fuera del TSX escaneado. Tampoco reportó falsos positivos.

El grano, el pautado y el rayado de vivienda no se consideran slop: son recursos localizados, documentados y con función narrativa o semántica dentro del sistema aprobado.

**Overlays visuales:** no existe overlay fiable visible para el usuario. El navegador integrado falló antes de crear pestaña por `codex/sandbox-state-meta: missing field sandboxPolicy`. La mutación sí funcionó en un Chromium fallback, pero el servidor Impeccable agotó el tiempo de arranque; por ello no se inyectó `detect.js` ni hubo logs `impeccable`.

## Overall Impression

La landing tiene una voz propia, madura y coherente con “precisa, serena y soberana”. Su mejor decisión es demostrar el patrimonio con una hoja auditada en lugar de limitarse a prometerlo. La mayor oportunidad es hacer que esa credibilidad sobreviva a todo el recorrido: hoy la animación puede ocultar contenido, una prueba se declara maqueta y el CTA final pide datos financieros sin mostrar las condiciones mínimas de confianza.

## Carga cognitiva

**Baja: 1 fallo de 8**, aunque la longitud acumulada genera fatiga.

- Foco único: aprobado; el CTA principal domina y la demo es secundaria.
- Chunking: falla; la transición y la composición del hero muestran cinco elementos equivalentes.
- Agrupación: aprobada mediante reglas, proximidad, filas y superficie.
- Jerarquía: aprobada; cubierta, cifra, capítulos y CTA se distinguen de inmediato.
- Una decisión cada vez: aprobada gracias al scroll narrativo.
- Opciones mínimas: aprobada; las decisiones principales son empezar, explorar o entrar.
- Memoria de trabajo: aprobada; la contracubierta recapitula la promesa.
- Divulgación progresiva: aprobada; el orden va de prueba general a capacidades y profundidad avanzada.

Puntos con más de cuatro elementos visibles: seis targets en el primer viewport —cuatro destinos únicos, con demo duplicada—; cinco categorías en la leyenda del hero; cinco capacidades con igual peso en “La transición”.

## Viaje emocional

- **Entrada:** “Evoluciona tu Excel” respeta el esfuerzo previo y crea alivio, no condescendencia.
- **Primer pico:** la hoja encartada con cifra, fecha, histórico, composición y deuda es la prueba más creíble de toda la landing.
- **Valle:** cinco capítulos centrales con el mismo ritmo convierten descubrimiento en inventario.
- **Segundo pico potencial:** “Sin conectar tu banco. A propósito” y “Tus datos salen contigo” responden al temor central de la audiencia.
- **Caída:** “Maqueta — captura real del chat pendiente” rompe la promesa de evidencia exacta justo en la sección del asistente.
- **Final:** “Tu Excel ya hizo su trabajo” es memorable, pero el cierre carece de precio, privacidad, seguridad, condiciones y ayuda.

## What's Working

1. **La metáfora es estructura, no decoración.** Cubierta, páginas, asientos, doble regla, columna de deuda y banding explican cómo se organizan los datos y sostienen la personalidad del producto.

2. **El hero demuestra “toda cifra se puede explicar”.** La cifra principal está acompañada por histórico, composición, filas, deuda, fecha y un enlace a datos demo reales. Evita el cliché de la gran métrica aislada.

3. **La respuesta responsive conserva la identidad.** En 1440, 834 y 390 px no hubo overflow horizontal ni titulares cortados. Tras revelar el contenido, dípticos, gráficas, chat y MCP se reorganizan sin perder orden. El modo de movimiento reducido deja todo visible y sin animaciones.

## Priority Issues

### [P1] El movimiento bloquea contenido fuera del viewport

- **Dónde:** `landing.module.css:760-769` y la orquestación basada en `IntersectionObserver`; capítulos centrales completos.
- **Evidencia:** en el primer estado había 12/18 elementos ocultos a 1440 px, 12 en tablet y 18/18 a 390 px. Tras recorrer la página quedaron 0 ocultos. La captura full-page inicial mostró secciones casi vacías.
- **Por qué importa:** una captura, impresión, automatización, scroll rápido o pausa del observer puede presentar una landing rota. La animación deja de enriquecer contenido visible y pasa a desbloquearlo.
- **Corrección:** mantener cada bloque visible en el estado base y limitar la coreografía a dibujo, énfasis o una transición que no persista oculta fuera del viewport.
- **Comando sugerido:** `$impeccable animate` y después `$impeccable harden`.

### [P1] La prueba del asistente se autodesautoriza como maqueta pendiente

- **Dónde:** sección “Asistente”, `landing-content.tsx:617-647`, especialmente el pie en torno a la línea 637.
- **Evidencia:** la propia tarjeta muestra “Maqueta — captura real del chat pendiente”.
- **Por qué importa:** la sección promete respuesta exacta y fuente, pero reconoce que su evidencia no es real. En una marca basada en auditabilidad, esta contradicción contamina la confianza en otros claims.
- **Corrección:** sustituirla por una captura real del flujo enviado o, mientras no exista, presentarla honestamente como “ejemplo de respuesta” sin afirmar que es captura del producto.
- **Comando sugerido:** `$impeccable harden`.

### [P1] La conversión final pide más confianza de la que demuestra

- **Dónde:** contracubierta y colofón, `landing-content.tsx:686-706`; el propio código deja el pie legal pendiente.
- **Evidencia:** no hay precio, privacidad, condiciones, seguridad, custodia ni contacto visibles antes de “Empezar con mis datos”.
- **Por qué importa:** el usuario va a entregar información patrimonial. “Base de datos propia” y export JSON son buenas señales, pero no sustituyen hechos y enlaces verificables.
- **Corrección:** incorporar un bloque breve “Antes de empezar” con hechos ya respaldados y accesos a precio, privacidad, condiciones, seguridad y contacto. No inventar garantías.
- **Comando sugerido:** `$impeccable harden` y `$impeccable clarify`.

### [P2] Los objetivos táctiles secundarios son demasiado pequeños

- **Dónde:** masthead, “Velo en la demo”, “Abre el libro” y colofón; reglas de tamaño en `landing.module.css`.
- **Evidencia:** en 390 px, 11 de 15 enlaces medidos tenían alguna dimensión menor de 44 px. Los CTA principales sí rondaron 46,6 px de alto, pero enlaces como “Velo en la demo” y “Abre el libro” medían unos 18 px de alto.
- **Por qué importa:** aunque los enlaces inline no incumplan automáticamente WCAG 2.5.8, son objetivos débiles para una persona móvil y distraída.
- **Corrección:** conservar el aspecto editorial mediante `inline-flex` y padding transparente hasta lograr un área táctil cómoda; priorizar demo, scroll cue y colofón.
- **Comando sugerido:** `$impeccable adapt` y `$impeccable audit`.

### [P2] El tramo medio convierte la identidad en una plantilla repetitiva

- **Dónde:** “Asiento Nº 01” a “Asiento Nº 05”, `landing-content.tsx:251-649` y `landing.module.css:689-753`.
- **Evidencia:** cada capítulo repite label pequeño, folio, regla y h2, aunque profundidad, mantenimiento, confianza y asistente no tienen el mismo peso persuasivo.
- **Por qué importa:** la jerarquía emocional se aplana y la segunda capa del diseño empieza a parecer una familia editorial generada por reflejo.
- **Corrección:** conservar el libro mayor y variar el tratamiento según la función: profundidad como prueba dominante, mantenimiento comprimido, confianza como interrupción y asistente como evidencia real. La numeración solo debe permanecer si comunica una secuencia necesaria.
- **Comando sugerido:** `$impeccable distill` y `$impeccable layout`.

## Persona Red Flags

### Jordan — primera visita

- FIRE, IRR, TWR, look-through, MCP, OAuth y JSON aparecen sin definición.
- El CTA es claro, pero no explica qué ocurrirá después, cuánto cuesta ni dónde encontrar ayuda.
- “Histórico cerrado” puede interpretarse como imposibilidad de corregir datos antes de comprender la auditabilidad.
- La repetición de la demo no sustituye una explicación breve del primer paso.

### Riley — stress tester

- Detectará la contradicción entre “Pruébalo en la demo” y “captura real pendiente”.
- Buscará privacidad, condiciones, seguridad y precio en el pie y no los encontrará.
- Una captura full-page inicial puede mostrar capítulos vacíos por la dependencia de `IntersectionObserver`.
- Claims absolutos como “nada se recalcula” o “jamás escribe ni estima” necesitan rutas visibles para verificar su alcance.

### Casey — móvil distraída

- Masthead y enlaces secundarios quedan fuera de la zona cómoda del pulgar y muchos no alcanzan un área de 44 px.
- Hero, leyendas y código MCP se adaptan, pero exigen leer texto fino durante una página muy larga.
- Después del hero no reaparece un CTA principal hasta el final; los enlaces intermedios a demo no ayudan a quien ya quiere registrarse.
- El estado inicial puede ocultar todos los bloques de reveal hasta comenzar a recorrer la página.

### Inés — usuaria exigente que ha superado Excel

- La hoja, los cierres y el preview le resultan creíbles, pero necesita ver cómo se importa y reconcilia su libro existente.
- Exportar JSON demuestra soberanía técnica, pero no aclara continuidad con CSV/Excel ni conservación de categorías e histórico.
- La landing prueba bien la fotografía patrimonial y menos el proceso de corrección auditada, conciliación y trazabilidad de fuente.
- Sin precio, seguridad y detalle de almacenamiento no puede comparar el riesgo de migrar con seguir manteniendo su hoja.

## Minor Observations

- Todos los pares de texto principales superan 4,5:1; los ratios medidos van de 6,11:1 a 14,74:1. El foco es visible con outline oro sobre cubierta y azul sobre papel.
- El modo `prefers-reduced-motion: reduce` funciona: `data-motion="off"`, 0 reveals ocultos, 0 stages ocultos y transiciones a 0 s.
- El orden de Tab observado fue coherente y no hubo trampa de foco.
- La sesión logged-out mostró “Entrar”; logged-in no se verificó por falta de sesión de prueba. La ruta de fuente cambia a “Ir a mi panel”.
- La integridad sin JS está respaldada por el HTML renderizado, `<noscript>`, `force-static` e invariantes de test, pero no se completó una prueba runtime no-JS porque el shell aislado no accedió al localhost.
- Por especificidad, el CTA primario computa texto azul en lugar de tinta de cubierta. Es una desviación P3, no un problema de contraste.
- “Explorar la demo” aparece dos veces en el primer viewport y alarga la navegación sin añadir un destino nuevo.
- El `themeColor` global no coincide con el verde de cubierta, por lo que el chrome móvil puede romper la continuidad visual.
- El favicon devolvió 404 en desarrollo; fue el único error de consola material.
- No se observó overflow horizontal, texto cortado, tarjetas sobre-redondeadas, sombras fantasma ni gradiente de texto.

## Questions to Consider

1. Si “soberana” es la promesa central, ¿por qué el último paso exige confianza sin mostrar precio, privacidad, seguridad ni condiciones?
2. ¿Merece el asistente un capítulo completo mientras su evidencia siga marcada como maqueta pendiente?
3. Si se eliminan todos los “Asiento Nº”, ¿se pierde información o solo decoración?
4. ¿Debe el movimiento servir para revelar contenido o para subrayar contenido que ya estaba disponible?
