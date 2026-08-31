/**
 * Identidad del prestador del servicio (#1172, PRD #1171 S1).
 *
 * El art. 10 de la LSSI-CE obliga a publicar nombre, NIF y un medio de contacto
 * «directo y efectivo» de forma permanente y gratuita. Este repositorio es
 * público (memoria del proyecto: los datos reales viven fuera de git), así que
 * esos datos entran por **variables de entorno** y nunca como literales en el
 * código; sin ellas la página lo dice con todas las letras en vez de inventar
 * un valor o publicar un hueco silencioso.
 *
 * La resolución es pura sobre un bag de env — misma forma que
 * `production-config.ts` — para que el estado «configurado / pendiente» sea
 * testeable sin renderizar nada.
 */

/** Las variables que llevan la identidad del prestador al aviso legal. */
export const LEGAL_IDENTITY_ENV = {
  contactEmail: "WORTHLINE_LEGAL_CONTACT_EMAIL",
  operatorName: "WORTHLINE_LEGAL_OPERATOR_NAME",
  postalAddress: "WORTHLINE_LEGAL_POSTAL_ADDRESS",
  taxId: "WORTHLINE_LEGAL_TAX_ID",
} as const;

/**
 * Las tres obligatorias, en el orden en que se leen en el aviso legal. El
 * domicilio postal queda fuera a propósito: el art. 10.1.a se satisface con un
 * canal de comunicación directa y efectiva (el email), y el research deja el
 * domicilio como prudencia a decidir con la gestoría.
 */
const MANDATORY = [
  LEGAL_IDENTITY_ENV.operatorName,
  LEGAL_IDENTITY_ENV.taxId,
  LEGAL_IDENTITY_ENV.contactEmail,
] as const;

export type LegalIdentity = {
  contactEmail: string | null;
  /** Nombres de las variables obligatorias aún sin configurar. */
  missing: string[];
  operatorName: string | null;
  postalAddress: string | null;
  taxId: string | null;
};

/**
 * El vendedor de registro del cobro (ADR-less, decisión del PRD #1160): worthline
 * presta el servicio, pero quien vende, factura e ingresa el IVA es el MoR. El
 * aviso legal, los términos y la política de reembolsos tienen que nombrarlo.
 */
export const MERCHANT_OF_RECORD = {
  name: "Paddle.com Market Ltd",
  privacyUrl: "https://www.paddle.com/legal/privacy",
  termsUrl: "https://www.paddle.com/legal/checkout-buyer-terms",
} as const;

/** Vacío, en blanco o solo espacios cuenta como ausente. */
function read(env: Record<string, string | undefined>, name: string): string | null {
  const value = (env[name] ?? "").trim();

  return value === "" ? null : value;
}

export function resolveLegalIdentity(
  env: Record<string, string | undefined>,
): LegalIdentity {
  return {
    contactEmail: read(env, LEGAL_IDENTITY_ENV.contactEmail),
    missing: MANDATORY.filter((name) => read(env, name) === null),
    operatorName: read(env, LEGAL_IDENTITY_ENV.operatorName),
    postalAddress: read(env, LEGAL_IDENTITY_ENV.postalAddress),
    taxId: read(env, LEGAL_IDENTITY_ENV.taxId),
  };
}

/** Adaptador fino sobre `process.env` para las páginas legales. */
export function readLegalIdentity(): LegalIdentity {
  return resolveLegalIdentity(process.env);
}
