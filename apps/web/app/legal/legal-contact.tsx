import type { LegalIdentity } from "./legal-identity";

/**
 * Piezas compartidas por los cinco textos (#1172): el canal de contacto y el
 * aviso de configuración pendiente.
 *
 * Cuando una variable de identidad no está puesta, la página **lo dice**. Un
 * hueco silencioso en el aviso legal es peor que un aviso feo: incumple el art.
 * 10 de la LSSI sin que nadie lo note, y el gate humano del slice existe justo
 * para que eso no llegue a producción.
 */

/** «pendiente de configurar», el texto que el test de contenido persigue. */
export const PENDING_LABEL = "pendiente de configurar";

/** El hueco de un dato sin configurar, en cursiva: se ve que no es un valor. */
export function PendingValue() {
  return <em>{PENDING_LABEL}</em>;
}

export function ContactEmail({ identity }: { identity: LegalIdentity }) {
  if (!identity.contactEmail) return <PendingValue />;

  return <a href={`mailto:${identity.contactEmail}`}>{identity.contactEmail}</a>;
}

/**
 * Aviso al operador —y a quien lea la página— de que faltan datos obligatorios,
 * nombrando la variable de entorno exacta que hay que rellenar.
 */
export function PendingIdentityNotice({ identity }: { identity: LegalIdentity }) {
  if (identity.missing.length === 0) return null;

  return (
    <p className="legalNotice">
      Algunos datos identificativos del prestador están <strong>{PENDING_LABEL}</strong>{" "}
      en este despliegue. Hasta que se configuren, esta página no cumple el artículo 10 de
      la Ley 34/2002: {identity.missing.join(", ")}.
    </p>
  );
}
