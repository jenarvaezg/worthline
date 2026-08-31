import type { LegalIdentity } from "./legal-identity";

/**
 * Piezas compartidas por los cinco textos (#1172): el canal de contacto y el
 * aviso de configuración pendiente.
 *
 * Cuando una variable de identidad no está puesta, la página **lo dice**. Un
 * hueco silencioso en el aviso legal es peor que un aviso feo: incumple el art.
 * 10 de la LSSI sin que nadie lo note, y el gate humano del slice existe justo
 * para que eso no llegue a producción.
 *
 * Qué se dice y a quién: al visitante, que faltan datos identificativos; al
 * operador, **qué variable** rellenar — por el log del servidor, no por una
 * página pública, que no es sitio para publicar los nombres de la configuración
 * del despliegue.
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
 * Aviso de que faltan datos obligatorios. El detalle accionable —los nombres de
 * las variables— sale por el log del servidor en el mismo render.
 */
export function PendingIdentityNotice({ identity }: { identity: LegalIdentity }) {
  if (identity.missing.length === 0) return null;

  console.warn(
    `[legal] aviso legal incompleto (#1172): faltan ${identity.missing.join(", ")}. ` +
      "Sin ellas la página no cumple el artículo 10 de la Ley 34/2002.",
  );

  return (
    <p className="premiumNotice">
      Los datos identificativos del prestador están <strong>{PENDING_LABEL}</strong> en
      este despliegue. Escríbenos por el canal de contacto y los facilitamos.
    </p>
  );
}
