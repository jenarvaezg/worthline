# Visión en el free tier de la Gemini API para el extractor de capturas de broker

- **Fecha:** 2026-07-10
- **Ticket:** [#852](https://github.com/jenarvaezg/worthline/issues/852) — "extractor" que convierte capturas de broker en JSON estructurado
- **Mapa wayfinder:** [#851](https://github.com/jenarvaezg/worthline/issues/851)
- **Autor:** research agent (fuentes primarias de Google AI + smoke real contra la API con la key free tier de `apps/web/.env.local`)

## Resumen ejecutivo

| Modelo | ¿Visión? | ¿JSON schema (REST)? | Tokens de la imagen (smoke) | Cifras correctas | Veredicto |
|---|---|---|---|---|---|
| `gemini-3.5-flash` | Sí (verificado) | Sí (verificado, HTTP 200) | **1073** (+1086 de "thinking") | 5/5 posiciones + total exactos | **APTO** como extractor principal |
| `gemini-3.1-flash-lite` | Sí (verificado) | Sí (verificado, HTTP 200) | **1073** (sin thinking tokens) | 5/5 posiciones + total exactos | **APTO** como fallback / alto volumen |

**Hipótesis del bucket de 20 RPD de `gemini-3.5-flash` como presupuesto del extractor: CONFIRMADA con holgura.** Una captura de broker realista (820×640 px) costó 1073 tokens de imagen. Contra el límite observado de 250K TPM eso es el ~0,43% del presupuesto de UN minuto, así que la imagen cabe holgadísima: el cuello de botella nunca serán los tokens sino las llamadas (RPM/RPD). 20 extracciones/día de `3.5-flash` es de sobra para uso familiar; y si hiciera falta más, `3.1-flash-lite` da 500 RPD con idéntica calidad en este caso.

## Parte A — Research documental (fuentes primarias)

### A.0 Verificación de modelos vía ListModels (empírico)

La key ve ambos modelos objetivo y exponen `generateContent` + `countTokens`. Confirmado con `GET /v1beta/models` (acceso 2026-07-10):

- `models/gemini-3.5-flash` — `generateContent, countTokens, createCachedContent, batchGenerateContent`; inputTokenLimit 1.048.576, output 65.536.
- `models/gemini-3.1-flash-lite` (y `-preview`) — mismos métodos; inputTokenLimit 1.048.576, output 65.536.

Nota: ListModels **no** expone un flag explícito de "vision"/modalidades; la capacidad de imagen se confirma por doc + por el smoke (ver Parte B). Ambos son modelos multimodales de la familia flash.

### A.1 Entrada de imagen: inline base64 vs Files API, límites, mime types, coste en tokens

Fuente: <https://ai.google.dev/gemini-api/docs/image-understanding> (acceso 2026-07-10).

- **Inline base64 vs Files API:** inline para imágenes pequeñas; Files API "for large files or to be able to use the same image file repeatedly".
- **Límite de tamaño (inline):** "Inline image data limits your total request size (text prompts, system instructions, and inline bytes) to **20MB**." (el límite es sobre el request completo, no solo la imagen).
- **MIME types soportados (5):** `image/png`, `image/jpeg`, `image/webp`, `image/heic`, `image/heif`.
- **Coste en tokens:**
  - "**258 tokens if both dimensions <= 384 pixels.**"
  - "Larger images are tiled into **768x768 pixel tiles, each costing 258 tokens.**"
  - Fórmula del crop unit: `floor(min(width, height) / 1.5)`, luego se divide cada dimensión por ese valor y se multiplica para obtener el número de tiles. Ejemplo de la doc: 960×540 → crop unit 360 → 3×2 = 6 tiles.
- **Máx. imágenes por request:** "Gemini models support a maximum of **3,600 image files per request.**"

> Nota práctica: el smoke reportó **1073** tokens para una imagen 820×640, ligeramente por encima de 258×4=1032. El número real lo da `usageMetadata.promptTokensDetails[modality=IMAGE]`, así que para presupuestar hay que fiarse de ese campo, no del cálculo teórico.

### A.2 ¿`gemini-3.5-flash` y `gemini-3.1-flash-lite` soportan visión?

Sí. La doc de image understanding aplica a la familia Gemini multimodal (flash incluidos) y el smoke lo confirma extremo a extremo: ambos leyeron correctamente una tabla renderizada en PNG. ListModels no publica un campo de capacidades de modalidad, por eso la confirmación fuerte es el smoke de la Parte B.

### A.3 Salida estructurada (responseSchema / JSON mode): ¿disponible en free tier y en estos modelos?

Fuente doc: <https://ai.google.dev/gemini-api/docs/structured-output> (acceso 2026-07-10). El esquema se describe como "a subset of the JSON Schema specification" (tipos `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`). La doc no menciona ninguna restricción a tier de pago.

**Verificación empírica (más fiable que la doc):** en el smoke usé la ruta clásica REST `generateContent` con:

```json
"generationConfig": {
  "responseMimeType": "application/json",
  "responseSchema": { "type": "object", "properties": { ... }, "required": [...] }
}
```

Ambos modelos devolvieron **HTTP 200** y JSON estrictamente conforme al esquema (objeto `{positions:[{name,units,marketValueEur}], totalEur}`), con la key **free tier**. Es decir: structured output funciona en free tier y en ambos modelos objetivo. (La página de doc que devolvió el fetch describía además una "Interactions API" más nueva con `response_format`/`mime_type`; no la usé — la ruta `generationConfig.responseSchema` de `generateContent` es la verificada aquí y es la que consume el AI SDK / los clientes REST habituales.)

### A.4 PDF de entrada (para v2)

Fuente: <https://ai.google.dev/gemini-api/docs/document-processing> (acceso 2026-07-10).

- **Límite:** "Gemini supports PDF files up to **50MB or 1000 pages**." (máx. 1000 páginas/request).
- **Coste:** "Each document page is equivalent to **258 tokens**."
- **Inline vs Files API:** ambos admiten hasta 50MB; para PDFs grandes o reutilizados, Files API.
- **Formatos:** el "document vision" solo entiende de verdad PDFs; otros formatos (TXT, MD, HTML, XML) se extraen como texto plano sin interpretar el render.

No probado en este smoke (aplazado a v2 según el ticket); queda documentado el límite para planificar.

### A.5 ¿Las imágenes cuentan especial contra TPM/RPD en free tier?

No se halló en fuentes primarias ninguna regla especial: las imágenes se convierten a tokens (258/tile) y esos tokens cuentan como cualquier otro token de entrada contra el TPM. El RPD/RPM cuenta **requests**, con lo que una request con imagen consume 1 request igual que una de solo texto. Confirmado por el smoke: `promptTokenCount` incluye los 1073 de imagen dentro del total de tokens del request. (Lo dejo también en "Lo que no pude verificar" porque no hay una página de rate limits citable que lo afirme literalmente para free tier.)

## Parte B — Smoke real

**Método:** HTML sintético con una tabla ficticia estilo broker (datos 100% inventados), renderizado y capturado a PNG 820×640 con Playwright (servido por HTTP local porque `file://` está bloqueado en el MCP). Una única llamada `generateContent` por modelo, imagen inline en base64 + prompt de extracción + `responseSchema`. La key NUNCA aparece en este documento; los datos son sintéticos, por eso los JSON van enteros.

### Tabla sintética de referencia (ground truth)

| Producto | Uds. | Valor de mercado |
|---|---|---|
| VWCE (Vanguard FTSE All-World) | 120 | 13.450,32 € |
| SXR8 (iShares Core S&P 500) | 18 | 9.876,50 € |
| EUNL (iShares Core MSCI World) | 42 | 4.512,18 € |
| AGGH (iShares Global Aggregate Bond) | 310 | 1.589,00 € |
| IB01 (iShares $ Treasury 0-1yr) | 7 | 771,05 € |
| **TOTAL** | | **30.199,05 €** |

### B.1 `gemini-3.5-flash`

- **HTTP:** 200 (tras un 503 "high demand" inicial que **no** consume cuota; a la primera reintento respondió). `finishReason: STOP`.
- **usageMetadata:** `promptTokenCount: 1127` (IMAGE **1073** + TEXT 54), `candidatesTokenCount: 167`, `thoughtsTokenCount: 1086`, `totalTokenCount: 2380`, `serviceTier: standard`.
- **JSON válido conforme al schema:** sí.
- **Cifras vs ground truth:** 5/5 posiciones y total exactos.

```json
{"positions":[{"name":"VWCE - Vanguard FTSE All-World","units":120,"marketValueEur":13450.32},{"name":"SXR8 - iShares Core S&P 500","units":18,"marketValueEur":9876.5},{"name":"EUNL - iShares Core MSCI World","units":42,"marketValueEur":4512.18},{"name":"AGGH - iShares Global Aggregate Bond","units":310,"marketValueEur":1589.0},{"name":"IB01 - iShares $ Treasury 0-1yr","units":7,"marketValueEur":771.05}],"totalEur":30199.05}
```

### B.2 `gemini-3.1-flash-lite`

- **HTTP:** 200 a la primera. `finishReason: STOP`.
- **usageMetadata:** `promptTokenCount: 1127` (IMAGE **1073** + TEXT 54), `candidatesTokenCount: 226`, sin `thoughtsTokenCount`, `totalTokenCount: 1353`, `serviceTier: standard`.
- **JSON válido conforme al schema:** sí.
- **Cifras vs ground truth:** 5/5 posiciones y total exactos.

```json
{"positions":[{"name":"VWCE","units":120,"marketValueEur":13450.32},{"name":"SXR8","units":18,"marketValueEur":9876.50},{"name":"EUNL","units":42,"marketValueEur":4512.18},{"name":"AGGH","units":310,"marketValueEur":1589.00},{"name":"IB01","units":7,"marketValueEur":771.05}],"totalEur":30199.05}
```

### Observaciones del smoke

- **Coste de imagen idéntico** en ambos modelos: 1073 tokens (mismo tokenizador de visión). Es el dato clave para presupuestar.
- **`3.5-flash` es un modelo "thinking":** gastó 1086 tokens de razonamiento invisibles que **sí** cuentan en `totalTokenCount` (2380). `flash-lite` no razona (total 1353). Para el extractor, `flash-lite` es más barato en tokens de salida y suficientemente preciso en este caso; `3.5-flash` da margen extra de robustez en capturas difíciles.
- **Diferencia de estilo:** `3.5-flash` fusionó ticker + nombre en `name`; `flash-lite` devolvió solo el ticker. Ambos respetaron el schema. Si se quiere separar ticker y nombre, conviene añadir campos explícitos al schema.

## Lo que no pude verificar

- **Cifras de rate limits del free tier desde fuente primaria citable.** Los 5 RPM / 250K TPM / 20 RPD (`3.5-flash`) y 15 RPM / 250K TPM / 500 RPD (`flash-lite`) son los valores *observados por cuenta* que aportó el ticket; no encontré una página oficial que los fije literalmente para free tier (varían por cuenta/región/momento). Presupuestar con margen.
- **Que las imágenes no tengan contabilidad especial contra TPM/RPD**: inferido del `usageMetadata` (los tokens de imagen van dentro de `promptTokenCount`), no hay página de rate limits que lo afirme palabra por palabra.
- **PDF (v2):** no ejecuté smoke; solo documenté límites (1000 págs / 50MB / 258 tokens por página).
- **Robustez ante capturas reales difíciles:** el smoke usó una tabla limpia y bien renderizada. Capturas de móvil, con reflejos, columnas desalineadas, formato numérico ambiguo (1.000 = mil vs uno) o multi-página no están cubiertas. Recomiendo un set de evals con capturas reales del padre antes de dar por bueno el extractor.
- **Estabilidad del 503:** `3.5-flash` dio un 503 "high demand" transitorio; conviene reintentos con backoff en el cliente (no cuenta contra RPD, pero degrada UX si no se maneja).

## Veredicto sobre la hipótesis del bucket de 20 RPD

**Confirmada.** `gemini-3.5-flash` sirve como extractor de visión principal para uso familiar: 20 extracciones/día es amplio, la imagen (~1073 tokens) cabe holgadísima en 250K TPM (una request completa ~2,4K tokens ≈ 1% de un minuto de presupuesto), y la salida JSON con schema es exacta en free tier. `gemini-3.1-flash-lite` es el fallback natural (500 RPD, misma precisión aquí, más barato en tokens y sin 503 en la prueba). Recomendación: `flash-lite` por defecto y `3.5-flash` como refuerzo para capturas difíciles, con reintentos/backoff para el 503.
