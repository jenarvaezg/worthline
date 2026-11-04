# The MyInvestor connector remembers the password only on opt-in, and syncs daily with it

Status: **accepted** (#1868, #1866, #1870). The two-step SMS from the server was not
tested in the prototype; the connection slice is its first real test.

## Context

MyInvestor has no read-only key. The only credential is the account's own password.
Its access token lasts 15 minutes and the refresh token 30, so no session survives
until the next day. A device that has already passed the SMS once (its `device_id`)
signs in with username and password **without a second factor**.

ADR 0115 makes MyInvestor a connected source that owns its holdings. It supplies
quantities only, and worthline always supplies the price. The connector is therefore
needed only when there is a new operation, and a daily sync is enough.

## Decision

1. **The password is remembered only on opt-in, per connection.** The checkbox is
   unticked by default, and its text is shown in full before it can be ticked:
   «Guardar la contraseña permite que worthline ponga tus datos al día cada día sin
   pedírtela. worthline solo la usa para leer, pero quien la obtenga puede entrar en
   tu cuenta de MyInvestor y verlo todo. MyInvestor exige que tus claves sean
   personales e intransferibles: si alguien las usa para un fraude, el banco puede
   alegar que no las protegiste y dejarte a ti la pérdida entera. Las órdenes y las
   transferencias siguen necesitando tu firma en el móvil: no apruebes nunca una
   notificación que no hayas pedido tú.»
   - Ticking the box also means accepting this statement, recorded with its date and
     the user who accepted it: «Entiendo el riesgo y lo asumo. worthline no se hace
     responsable de las pérdidas que puedan derivarse de guardar o usar esta
     contraseña.»
   - With the opt-in, the connection's `credentials_json` stores the username
     (DNI/NIE), the password and the `device_id`, sealed (ADR 0030).
   - Without it, only the `device_id` is stored.
   - The password is deleted on the first rejection, on disconnect, or when the box
     is unticked.
2. **The connector is a premium feature.** The workspace gate is the existing premium
   ingestion gate (`isPremiumIngestionAllowed`). When the plan lapses, the connection
   pauses like any other source; nothing is deleted.
3. **The connection belongs to the workspace**, like Binance. Syncing needs a write
   grant; a viewer cannot sync (ADR 0112).
4. **There are two triggers**:
   - a «Poner al día» button, which asks for the password when none is remembered;
   - the daily capture cron, next to Binance and Numista, and only with a remembered
     password.

   MyInvestor does not notify the user of each sign-in, so a daily login is not
   noise. One sync runs per connection at a time; the button waits for a sync in
   progress instead of starting a second one.
5. **What a periodic sync reads**: positions, the cash balance, the scheduled
   contributions, and the orders since the last good sync plus a 30-day overlap.
   Then it runs the exact-units check (ADR 0115). The full history is read only when
   connecting. «Resync all» exists only as the manual repair of a units mismatch.
6. **The two-step SMS keeps its pending step in the database.** The `request_id` is
   sealed, lives 5 minutes and is tied to the connection, never to a cookie. **The
   cron never sends an SMS.**
7. **Each error maps to an action:**

   | Error | Action |
   | --- | --- |
   | Password rejected | Delete the stored password, stop the periodic sync, raise a signal. Never retried automatically. Three rejections in one day lock the connection until the next day. |
   | Re-login rejected with no reason | 24-hour pause. |
   | Network or WAF | Up to three retries with backoff in the same pass. The «connector failing» signal waits for three consecutive failed days. |
   | SMS required (the `device_id` expired) | Stop the periodic sync and raise «verify the phone again». |

   Further limits:
   - at most 10 logins per connection per day;
   - no cash movements are requested; the cash enters as a balance.
8. **Every attempt is logged in the workspace**, whether it came from the button or
   from the cron. It records the date, origin, result, error type, failing step
   (login, positions, orders, plans), HTTP code and duration. It never records
   amounts, ISINs or identifiers. The rows are kept for 90 days. The holding's card
   shows the last good sync.
9. **Health signals** (#654):
   - With a periodic sync, a scheduled contribution whose window passes without a
     matching order raises «la aportación del día X no ha llegado».
   - Without a remembered password, the signal stays «sin sincronizar», plus a soft
     reminder after 45 days without a sync.
   - «El conector falla» is raised per data type: positions, orders, plans.
10. **Every call to MyInvestor leaves through a thin relay on a Cloudflare Worker.**
    In #1866, logins from Vercel's egress (`dub1`) were rejected with
    `403 SECURITY_001`, while the same code passed from a residential IP and from a
    Cloudflare Worker.
    - The Worker only forwards requests to `api.myinvestor.es`, is locked with a
      shared secret, and never stores or logs a body.
    - worthline keeps all the logic: errors, limits, the attempt log, and the sealed
      credentials, which travel per request.
    - Removing the relay changes nothing else.
    - `SECURITY_001` is a rejection with no reason under decision 7: a 24-hour pause,
      never a deleted password.

## Consequences

- **Security.** Whoever obtains both the Turso database and
  `WORTHLINE_ENCRYPTION_KEY` can sign in and read a remembered account. «worthline
  never trades» is a promise about our code, not a property of the credential, and no
  copy may claim otherwise.
- **The relay is not proven under daily load.** A Worker on Cloudflare's Dublin node,
  called from Vercel, was also rejected once in #1866, probably because of several
  logins within minutes. The attempt log and the «connector failing» signal will show
  it. If the daily login turns out unreliable, the fallback is the «Poner al día»
  button and the PDF import (#1793), not a server of our own.
- **This reopens** if MyInvestor offers a read-only key or an official access. The
  connector then moves to it and stops storing the password.

## Considered options

- **Never store the password; sync only with the user present.** Rejected: it gives
  up the daily sync and the «contribution has not arrived» signal, which is most of
  the value.
- **A local CLI that pushes to worthline.** Rejected in #1863: the connector runs on
  the server.

## Amendment (#1876, 2026-11-04) — the button's origin is `manual`

Decision 8 logs the origin of every attempt, and #1885 named the two values `button`
and `cron`. The log is `sync_run` (#885, #1061), whose `trigger` was already
`cron | manual | connect` for every source, and the pass's lease says the same
(`manual | cron`). A press of «Poner al día» is therefore logged as `manual`, the word
Binance and Numista already write for their own button, and not as `button`: one
vocabulary for the attempt log of every connected source.
