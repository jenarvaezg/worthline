/**
 * The words of the MyInvestor connection (#1879). Client-safe: the form island and
 * the server actions read the same constants, so a refusal says the same thing
 * whichever side decides it.
 */

/** The literal text of ADR 0114, decision 1. It is copied, never reworded. */
export const MYINVESTOR_RISK_TEXT =
  "Guardar la contraseña permite que worthline ponga tus datos al día cada día sin " +
  "pedírtela. worthline solo la usa para leer, pero quien la obtenga puede entrar en " +
  "tu cuenta de MyInvestor y verlo todo. MyInvestor exige que tus claves sean " +
  "personales e intransferibles: si alguien las usa para un fraude, el banco puede " +
  "alegar que no las protegiste y dejarte a ti la pérdida entera. Las órdenes y las " +
  "transferencias siguen necesitando tu firma en el móvil: no apruebes nunca una " +
  "notificación que no hayas pedido tú.";

/** The statement ticking the box accepts (ADR 0114, decision 1), literal too. */
export const MYINVESTOR_ACCEPTANCE_TEXT =
  "Entiendo el riesgo y lo asumo. worthline no se hace responsable de las pérdidas " +
  "que puedan derivarse de guardar o usar esta contraseña.";

/** Minutes the pending step of the SMS lives (ADR 0114, decision 6). */
export const MYINVESTOR_PENDING_TTL_MINUTES = 5;

/** Why the «Sin conectar» row offers no fold, one line each (the design of #1879). */
export const MYINVESTOR_PREMIUM_LINE = "Conectar MyInvestor es premium.";
export const MYINVESTOR_READ_ONLY_LINE =
  "Conectar una fuente necesita permiso para editar este workspace.";
/** The relay (ADR 0114 decision 10) is not configured on this server. */
export const MYINVESTOR_UNAVAILABLE_LINE =
  "Conectar MyInvestor aún no está disponible en este servidor.";

export const MYINVESTOR_ALREADY_CONNECTED = "Ya hay una cuenta de MyInvestor conectada.";
export const MYINVESTOR_NOT_FOUND = "No se encontró la conexión de MyInvestor.";

export const MYINVESTOR_LOGIN_ERRORS = {
  network_or_waf:
    "No hemos podido hablar con MyInvestor. No se ha guardado nada; vuelve a intentarlo en unos minutos.",
  password_rejected:
    "MyInvestor no acepta ese usuario o esa contraseña. No se ha guardado nada.",
  rejected_no_reason:
    "MyInvestor ha rechazado el acceso sin decir por qué. Suele pasar tras varios intentos seguidos: vuelve a probar mañana.",
  unexpected:
    "MyInvestor ha contestado algo que no esperábamos. No se ha guardado nada; vuelve a intentarlo más tarde.",
} as const;

export const MYINVESTOR_CODE_REJECTED =
  "Ese código no es el que ha mandado MyInvestor. Revisa el SMS y vuelve a escribirlo.";

/** Wrong codes the same SMS step accepts before it is dropped. */
export const MYINVESTOR_MAX_CODE_ATTEMPTS = 5;

export const MYINVESTOR_TOO_MANY_CODES =
  "Demasiados códigos equivocados, así que no se ha guardado nada. Vuelve a escribir la contraseña y MyInvestor te mandará otro.";

export const MYINVESTOR_PENDING_EXPIRED =
  "El código ha caducado: pasaron más de 5 minutos. Vuelve a escribir la contraseña y MyInvestor te mandará otro.";

/** Re-saving the password on a connected row needs no SMS; if MyInvestor asks, the device lapsed. */
export const MYINVESTOR_DEVICE_LAPSED =
  "MyInvestor pide verificar el móvil otra vez, así que no se ha guardado nada. Usa «Volver a entrar» para recibir el SMS: no se desconecta nada.";

/** «Volver a entrar» while the connection waits out a pause or the day's lock. */
export const MYINVESTOR_REENTER_PAUSED =
  "La conexión está en pausa para no bloquearte la cuenta, así que no se ha preguntado a MyInvestor. Vuelve a entrar cuando acabe la pausa.";

export const MYINVESTOR_SAVE_REJECTED =
  "MyInvestor no acepta ese usuario o esa contraseña. No se ha guardado.";
