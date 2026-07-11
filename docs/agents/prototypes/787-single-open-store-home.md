# Prototype: un `openStore` por request en `/` (#787)

> **Decisión:** [#787](https://github.com/jenarvaezg/worthline/issues/787) · implementación [#903](https://github.com/jenarvaezg/worthline/issues/903).

## Pregunta

¿Cómo eliminamos la doble apertura de store en `/` sin romper el streaming Suspense?

## Estado actual

```
page.tsx (sync)
  openStore → readWorkspace + readAssets + readWarningOverrides → close
  └─ Shell (nav, scope, warnings, footer)
       └─ Suspense
            dashboard-content.tsx
              openStore → loadDashboard (assets vía projection context) → close
```

Coste P0-3 (audit): **dos conexiones libSQL** (Turso remoto en prod) + **`readAssets` redundante** en shell — `loadDashboard` ya lee assets/override en el mismo request.

## Opciones evaluadas

| Opción | Qué hace | Veredicto |
|--------|----------|-----------|
| **A** `cache(openStore)` + `after(close)` | Una conexión compartida shell + body | **Sí — núcleo** |
| **B** Shell sin `readAssets`; warnings del body | Quita full-scan duplicado; warnings streamed | **Sí — complemento** |
| **C** Pasar `shellData` serializable al hijo | Evita re-leer workspace en body | **No** — no quita la 2ª conexión; ahorro marginal |

## Decisión: **A + B**

### A — `getRequestStore` (request-scoped)

Nuevo seam `request-store.ts`:

```typescript
export const getRequestStore = cache(async () => {
  const target = await readStoreTarget();
  const store = await openStore(target);
  after(() => store.close());
  return store;
});
```

- `openStore` / `withStore` **sin cambio** — resto de rutas y server actions.
- Solo `/` migra shell + body a `getRequestStore()`; **sin** `store.close()` local.
- `React.cache()` deduplica entre `page.tsx` y el hijo Suspense (mismo request).
- `after()` cierra tras enviar la respuesta completa (todos los boundaries Suspense).

### B — Shell ligero + warnings streamed

- Shell: solo `readWorkspace` → scopes.
- Warnings: `state.warnings` de `loadDashboard` (`prepareDashboardState` ya llama `collectWarnings`).
- `<WarningsBand>` extraído de `shell.tsx`; primer fragmento del hijo Suspense.

## Fuera de alcance

- Generalizar `getRequestStore` a otras rutas.
- Cambiar `force-dynamic` (niebla del mapa, post-#895).
