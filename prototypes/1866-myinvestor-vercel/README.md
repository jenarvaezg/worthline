# PROTOTIPO DESECHABLE · #1866

¿El login de MyInvestor y sus lecturas pasan **desde una función de Vercel real**, de forma sostenida? Esta rama (`prototype/1863-myinvestor-vercel`) no se mergea nunca.

Es un proyecto de Vercel aparte (`proto-1866-myinvestor`), no un preview de worthline. Así no gasta builds de la app y su cron corre de verdad. La pregunta es de red: la IP de salida de Vercel y si Imperva la deja pasar. Para eso basta la misma infraestructura de Vercel y la misma región que la producción (`dub1`).

## Qué hace

- `GET /api/run`: el ciclo del cron diario (ADR 0114). Login directo con la contraseña guardada, refresh y lecturas: cuentas de valores con todas sus órdenes, y cuentas de planes con todas sus órdenes. El cron de Vercel lo lanza cada día a las 09:00 UTC.
- `POST /api/sms?step=start|finish`: el login con SMS en dos pasos desde un `device_id` nuevo, cada paso en una invocación distinta.

Cada ejecución guarda **solo metadatos** en la BD de Turso desechable `proto-1866`: paso, código HTTP, latencia, si respondió Imperva, número de filas, región e IP de salida. Nunca importes, ISIN, ids ni tokens.

## Variables (proyecto de Vercel `proto-1866-myinvestor`)

| Variable | Quién la pone |
| --- | --- |
| `MYINVESTOR_CUSTOMER_ID`, `MYINVESTOR_PASSWORD` | Jose, a mano |
| `MYINVESTOR_DEVICE_ID` | un UUID nuevo, verificado con el paso del SMS |
| `CRON_SECRET` | aleatorio |
| `PROTO_DB_URL`, `PROTO_DB_TOKEN` | la BD `proto-1866` y un token solo para ella |

Al cerrar #1866 se borran el proyecto de Vercel, sus variables y la BD.
