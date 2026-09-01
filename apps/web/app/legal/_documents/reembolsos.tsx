import { ContactEmail } from "@web/legal/legal-contact";
import type { LegalDocumentProps } from "@web/legal/legal-documents";
import { MERCHANT_OF_RECORD } from "@web/legal/legal-identity";

/**
 * Política de reembolsos (#1172) — el merchant of record la exige al vendedor, y
 * el derecho de desistimiento del TRLGDCU la respalda.
 *
 * Decisión tomada (research #1136, opción 1): se honran los **14 días también
 * para el lifetime**, en vez de presentar la renuncia al desistimiento en el
 * checkout. Es la opción más barata en fricción y la coherente con el compromiso
 * de wind-down de #1132 («reembolso a petición»). Escribirlo así convierte el
 * derecho en algo que no hay que discutir.
 */
export default function ReembolsosDocument({ identity }: LegalDocumentProps) {
  return (
    <>
      <h2>Política de reembolsos</h2>

      <p className="legalLede">
        Tienes <strong>14 días</strong> naturales desde la compra para pedir la
        devolución, <strong>sin dar explicaciones</strong>. Vale para la suscripción y
        vale <strong>también</strong> para la compra <strong>lifetime</strong>, aunque
        hayas empezado a usarla.
      </p>

      <h3>1. El derecho de desistimiento, y algo más</h3>

      <p>
        Como persona consumidora, la ley te da 14 días naturales para desistir de un
        contrato a distancia. En los contenidos digitales ese derecho se puede perder si
        consientes expresamente empezar de inmediato; worthline <strong>no</strong> te va
        a pedir esa renuncia. Preferimos que pruebes el producto entero con la puerta
        abierta: si en esos 14 días decides que no, se devuelve el dinero.
      </p>

      <h3>2. Cómo se pide</h3>

      <ol>
        <li>
          Escribe a <ContactEmail identity={identity} /> desde el correo de tu cuenta,
          diciendo que quieres el reembolso. No hace falta motivo ni formulario.
        </li>
        <li>
          El pago lo gestiona <strong>{MERCHANT_OF_RECORD.name}</strong> como vendedor de
          registro, así que la devolución se cursa a través de él, al mismo medio de pago
          que usaste. También puedes escribirle directamente desde el correo de
          confirmación de tu compra.
        </li>
        <li>
          El importe se devuelve sin demora indebida una vez aceptada la solicitud; el
          tiempo que tarde en aparecer depende de tu banco.
        </li>
      </ol>

      <h3>3. Qué pasa con tu cuenta y tus datos</h3>

      <p>
        Al reembolsar, la cuenta vuelve al plan gratuito. Tus datos siguen ahí, intactos:
        el seguimiento manual y todas las lentes de lectura son gratis y no dependen de
        que pagues. Si además quieres irte del todo, puedes exportar todo tu workspace y
        eliminarlo desde Ajustes.
      </p>

      <h3>4. Cancelar una suscripción</h3>

      <p>
        Cancelar y pedir un reembolso son cosas distintas. Puedes cancelar la suscripción
        cuando quieras desde la aplicación: no se cobra ninguna renovación más y conservas
        el acceso premium hasta el final del periodo ya pagado. Pasados los 14 días
        iniciales, un periodo ya empezado no se prorratea salvo que el fallo sea nuestro.
      </p>

      <h3>5. Si el servicio falla</h3>

      <p>
        Si worthline no funciona como se anuncia y no lo arreglamos en un plazo razonable,
        tienes derecho a que se corrija o a que se te devuelva lo pagado por el periodo
        afectado, con independencia de los 14 días. Escribe y lo miramos: no hay guion de
        retención.
      </p>

      <h3>6. Si worthline cerrara</h3>

      <p>
        Si el servicio <strong>cesara</strong>, se avisará con al menos 30 días de
        antelación y la exportación de datos seguirá disponible. Quien tenga el plan{" "}
        <strong>lifetime</strong> podrá pedir el reembolso <strong>íntegro</strong> de su
        compra —sin prorrateos—, tal y como se recoge en los{" "}
        <a href="/legal/terminos">términos de servicio</a>. El compromiso está escrito
        para que no dependa de la buena voluntad de nadie.
      </p>

      <p>
        Si tienes una <strong>suscripción</strong> en ese momento: no se cobra ninguna
        renovación más, conservas el acceso premium hasta el final del periodo ya pagado y
        después la cuenta pasa al plan gratuito con todos tus datos intactos.
      </p>

      <h3>7. Reclamaciones</h3>

      <p>
        Si no estás conforme con la respuesta, puedes acudir a las autoridades de consumo
        de tu país de residencia. Antes, escríbenos: casi todo se resuelve por correo, y
        una devolución peleada es una devolución mal hecha.
      </p>
    </>
  );
}
