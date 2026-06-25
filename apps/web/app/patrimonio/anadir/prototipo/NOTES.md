# Prototipo — Asistente de alta de holdings (UI)

**Pregunta que responde:** ¿qué _forma_ de asistente se siente mejor para alguien
no técnico (caso guía: el padre de Jose) al dar de alta sus holdings? El _contenido_
ya está decidido en el grill (ver `scratchpad/holding-wizard-ux-brief.md`); aquí solo
varía la forma.

**Cómo verlo:** `npm run dev` → `http://localhost:3000/patrimonio/anadir/prototipo`
(requiere estar logueado en local). Conmuta variante con la barra flotante inferior
o las flechas ← →, o con `?variant=A|B|C`.

## Variantes

- **A — Asistente a pantalla completa.** Una pregunta por pantalla, progreso, atrás.
  Incluye el arranque continuo ("¿solo o varios?") y el bucle de éxito. El "te lleva
  de la mano". Más pantallas; pensado para el primer contacto.
- **B — Una sola página que se revela.** Tiles de cajón arriba → campos mínimos
  inline → reparto → botón pegajoso. Todo en un scroll. Rápido para uso repetido.
- **C — Dos paneles.** Rail de cajones + lienzo con campos + **tarjeta-previa amable**
  (lo que vas a añadir en cristiano, NO el readout técnico "Se creará"). Contexto
  siempre visible; orientado a escritorio.

Todas comparten: 5 cajones, lenguaje llano, bifurcación inversión (saldo de hoy vs
importar extracto), inmueble "¿cuánto vale hoy?", deuda nombre+saldo, reparto de un
toque (default "de los dos"), sin jerga ni panel técnico.

## Atajos del prototipo (no son decisiones de producto)

- Iconos = emoji (real: SVG del design-system).
- Datos mock en memoria; "Añadir" no persiste; importar CSV es stub.
- Estado del formulario compartido entre variantes; cambiar de variante remonta.

## VEREDICTO (2026-06-25): **gana B — una sola página que se revela**

- **A descartada:** amistosa, pero demasiados pasos aunque el contenido sea el mismo.
- **B ganadora:** todo en un scroll, rápido. Es la forma a plegar en producción.
- **Requisito que B debe mantener (Jose):** la **búsqueda de activo con precio en
  vivo** (buscar BTC en CoinGecko, fondos en Yahoo) DENTRO del cajón de inversión,
  una vez elegido el grupo. Reusa la `SymbolSearch` actual. Ya añadida al prototipo
  (componente `MockSymbolSearch`): grupo → buscar → resultado con precio en vivo →
  "¿cuánto tienes?" deriva participaciones (o importar extracto). Matiz vs grill Q3:
  NO buscar-primero (eso era lo fiddly); buscar va después de elegir grupo, scopeado
  a su proveedor (lo que esquiva el problema de buscar cross-provider).
- C no elegida (pero su "tarjeta-previa amable" es un buen injerto a considerar).

**Siguiente:** plegar B en `/patrimonio/anadir` (asistente por defecto) + arranque
continuo en `/empezar`, con la búsqueda real cableada; borrar este directorio +
switcher. Opcional: filar como PRD con slices antes de implementar.
