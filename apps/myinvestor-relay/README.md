# Relé de MyInvestor (Cloudflare Worker)

Desde la salida de Vercel, MyInvestor rechaza el login con `403 SECURITY_001 «Captcha required»`. El mismo código entra desde un Cloudflare Worker (#1866). Por eso todas las llamadas del conector salen por este relé (ADR 0114, decisión 10).

## Qué hace

- **Exige el secreto compartido** en la cabecera `x-relay-secret`. Sin él, o con uno distinto, responde `401`. Si el Worker no tiene secreto configurado, responde `500` y no reenvía nada.
- **Solo reenvía a `https://api.myinvestor.es`.** El destino llega en `x-relay-target`. Cualquier otro host, esquema, puerto o URL con credenciales recibe `403`, y solo se aceptan `GET` y `POST`. Las redirecciones no se siguen.
- **No guarda ni registra nada.** Pasan los bytes del cuerpo, el estado HTTP y el `content-type`. Las cabeceras de Cloudflare y del relé se quedan en el Worker, y las cookies de MyInvestor no vuelven. No tiene estado ni bindings, y `observability` está apagado.
- **Sus propios rechazos llevan `x-relay-error`** (`unauthorized`, `forbidden_target`, `missing_target`, `method_not_allowed`, `misconfigured`, `upstream_unreachable`). Así el cliente los distingue de las respuestas de MyInvestor.

Toda la lógica vive en worthline: el mapa de errores, los reintentos, los límites y las credenciales selladas. El cliente está en `packages/pricing/src/myinvestor/`. Quitar el relé solo cambia el transporte.

## Desarrollo

```sh
bun run --filter @worthline/myinvestor-relay test
bun run --filter @worthline/myinvestor-relay typecheck
```

Los tests usan un `fetch` falso y nunca llaman a MyInvestor.

## Despliegue (lo hace el dueño del despliegue, con `!`)

Hace falta una cuenta de Cloudflare. El plan gratuito cubre el uso.

1. Genera el secreto compartido y guárdalo en tu gestor de contraseñas:

   ```sh
   ! openssl rand -hex 32
   ```

2. Despliega el Worker desde esta carpeta:

   ```sh
   ! cd apps/myinvestor-relay && bunx wrangler@4 login
   ! cd apps/myinvestor-relay && bunx wrangler@4 deploy
   ```

   Anota la URL que imprime, del tipo `https://worthline-myinvestor-relay.<subdominio>.workers.dev`.

3. Pon el secreto en el Worker. `wrangler` lo pide por teclado, así que no queda en el historial:

   ```sh
   ! cd apps/myinvestor-relay && bunx wrangler@4 secret put RELAY_SECRET
   ```

4. Pon las dos variables en el proyecto de Vercel de worthline, en *production* y en *preview*:

   ```sh
   ! vercel env add MYINVESTOR_RELAY_URL production
   ! vercel env add MYINVESTOR_RELAY_SECRET production
   ! vercel env add MYINVESTOR_RELAY_URL preview
   ! vercel env add MYINVESTOR_RELAY_SECRET preview
   ```

   - `MYINVESTOR_RELAY_URL` es la URL del paso 2, en `https`.
   - `MYINVESTOR_RELAY_SECRET` es el mismo valor que `RELAY_SECRET`, de 32 caracteres como mínimo.

   Las dos van juntas. Si solo hay una, o la URL no es `https`, o el secreto es corto, el servidor no arranca (`instrumentation.ts`). Si no está ninguna, el conector de MyInvestor queda apagado.

5. Comprueba el relé:

   ```sh
   # Sin secreto: 401 y x-relay-error: unauthorized
   ! curl -si https://worthline-myinvestor-relay.<subdominio>.workers.dev/ | head -5
   # Otro host: 403 y x-relay-error: forbidden_target
   ! curl -si -H "x-relay-secret: $SECRETO" -H "x-relay-target: https://example.com/" https://worthline-myinvestor-relay.<subdominio>.workers.dev/ | head -5
   ```

   La prueba de punta a punta (login y lecturas) llega con el slice de conexión (#1879).

## Rotar el secreto

Repite los pasos 1, 3 y 4 con un valor nuevo y vuelve a desplegar worthline en Vercel. Mientras el Worker y Vercel no coinciden, cada llamada falla con `relay_rejected` y no se reintenta.

## Si el relé deja de servir

Lo sabremos por el registro de intentos y la señal «el conector falla» (#1885). Si el login diario por el relé falla a menudo, la salida es el botón «Poner al día» más el PDF (#1793), no un servidor propio (ADR 0114).
