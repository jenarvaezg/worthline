/**
 * Encargados del tratamiento (#1172, RGPD art. 28) que worthline usa hoy.
 *
 * Datos, no prosa: la política de privacidad los pinta como tabla y el test de
 * contenido comprueba que la lista publicada coincide con quien de verdad recibe
 * datos. Groq **no** está — salió del pool de proveedores el 2026-07-30 (#1278),
 * así que no recibe nada y declararlo sería declarar una cesión que no ocurre.
 *
 * Dos precisiones que el research (#1136) traía mal y el código desmiente:
 * quien autentica la web es **Google** vía next-auth (`auth.config.ts`), no
 * WorkOS — WorkOS solo emite el OAuth del servidor MCP (ADR 0034); y **Sentry y
 * Resend** todavía no están instalados (son slices posteriores del PRD #1171),
 * así que van marcados `active: false` hasta que traten su primer dato.
 *
 * Fuentes de cada DPA y de la postura de entrenamiento de los LLM: el research
 * `docs/research/2026-07-18-minimo-legal-salida.md` (#1136).
 */

export type LegalProcessor = {
  /**
   * `false` mientras el proveedor esté declarado pero todavía no reciba ni un
   * dato — la función que lo usa aún no existe. Declarar en presente una cesión
   * que no ocurre es tan impreciso como callar una que sí.
   */
  active?: boolean;
  /** Amparo de la transferencia internacional y del encargo. */
  mechanism: string;
  name: string;
  /** Qué hace por worthline y qué datos ve. */
  purpose: string;
};

export const LEGAL_PROCESSORS: readonly LegalProcessor[] = [
  {
    mechanism: "DPA con cláusulas contractuales tipo de la UE",
    name: "Vercel",
    purpose: "Alojamiento y ejecución de la aplicación (Estados Unidos).",
  },
  {
    mechanism: "DPA aceptado desde la cuenta",
    name: "Turso",
    purpose: "Base de datos: tu workspace vive en su propia base de datos.",
  },
  {
    mechanism:
      "Condiciones de Google Cloud / Workspace, con cláusulas contractuales tipo",
    name: "Google (inicio de sesión)",
    purpose:
      "Autenticación: worthline recibe de Google el correo con el que inicias sesión.",
  },
  {
    mechanism: "DPA con lista de subencargados",
    name: "WorkOS",
    purpose: "OAuth del servidor MCP: solo si conectas un cliente de agente a tus datos.",
  },
  {
    active: false,
    mechanism: "DPA publicado",
    name: "Resend",
    purpose: "Correo transaccional: tu dirección y el contenido del propio aviso.",
  },
  {
    active: false,
    mechanism: "DPA con Data Privacy Framework y cláusulas contractuales tipo",
    name: "Sentry",
    purpose: "Errores técnicos, con los datos personales filtrados antes de enviarse.",
  },
  {
    mechanism: "Condiciones de la API de pago: no entrenan con los datos enviados",
    name: "Google (Gemini API)",
    purpose: "Modelo del asistente: recibe el contexto financiero de tu consulta.",
  },
  {
    mechanism: "No retiene ni entrena con las entradas ni las salidas",
    name: "Cerebras",
    purpose: "Modelo del asistente: recibe el contexto financiero de tu consulta.",
  },
] as const;
