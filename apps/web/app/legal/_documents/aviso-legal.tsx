import {
  ContactEmail,
  PendingIdentityNotice,
  PendingValue,
} from "@web/legal/legal-contact";
import type { LegalDocumentProps } from "@web/legal/legal-documents";
import { MERCHANT_OF_RECORD } from "@web/legal/legal-identity";

/**
 * Aviso legal (#1172) — art. 10 de la Ley 34/2002 (LSSI-CE): nombre, NIF y un
 * medio de comunicación directa y efectiva, «permanente, fácil, directa y
 * gratuita». Los datos entran por env (repo público); el domicilio postal es
 * prudencia, no obligación, y solo se publica si está configurado.
 *
 * El apartado b) del art. 10 (Registro Mercantil) no aplica: un autónomo no
 * inscrito no tiene ese dato.
 */
export default function AvisoLegalDocument({ identity }: LegalDocumentProps) {
  return (
    <>
      <h2>Aviso legal</h2>

      <p>
        Esta página identifica a quien presta el servicio de worthline, en cumplimiento
        del artículo 10 de la <strong>Ley 34/2002</strong>, de servicios de la sociedad de
        la información y de comercio electrónico (LSSI-CE).
      </p>

      <PendingIdentityNotice identity={identity} />

      <h3>Titular del servicio</h3>

      <dl className="legalIdentity">
        <dt>Nombre</dt>
        <dd>{identity.operatorName ?? <PendingValue />}</dd>

        <dt>NIF</dt>
        <dd>{identity.taxId ?? <PendingValue />}</dd>

        <dt>Contacto</dt>
        <dd>
          <ContactEmail identity={identity} />
        </dd>

        {identity.postalAddress ? (
          <>
            <dt>Domicilio a efectos de notificaciones</dt>
            <dd>{identity.postalAddress}</dd>
          </>
        ) : null}
      </dl>

      <p>
        El titular es una persona física que ejerce como profesional autónomo y no está
        inscrita en el Registro Mercantil, por lo que no procede el dato de inscripción
        que el artículo 10 pide «en su caso».
      </p>

      <h3>Actividad</h3>

      <p>
        worthline es una aplicación web para llevar el seguimiento del patrimonio personal
        y familiar: registras tus activos y tus deudas, y la aplicación calcula y presenta
        tu patrimonio neto, su evolución y sus retornos. No gestiona dinero, no ejecuta
        operaciones y no presta asesoramiento financiero — ver el{" "}
        <a href="/legal/no-asesoramiento">aviso de no asesoramiento</a>.
      </p>

      <h3>Quién vende y quién factura</h3>

      <p>
        Las suscripciones y las compras de worthline se cursan a través de{" "}
        <strong>{MERCHANT_OF_RECORD.name}</strong>, que actúa como{" "}
        <strong>vendedor de registro</strong> de la transacción: es quien te vende, quien
        emite la factura con el IVA que corresponda a tu país y quien procesa los
        reembolsos. El servicio, en cambio, lo presta y lo opera el titular identificado
        más arriba.
      </p>

      <p>
        Condiciones de compra del vendedor de registro:{" "}
        <a href={MERCHANT_OF_RECORD.termsUrl} rel="noreferrer noopener" target="_blank">
          términos para compradores de {MERCHANT_OF_RECORD.name}
        </a>
        .
      </p>

      <h3>Precios e impuestos</h3>

      <p>
        Los precios que se muestran al contratar indican de forma expresa si incluyen los
        impuestos aplicables. El importe final, con los impuestos de tu país de
        residencia, se muestra en el proceso de pago antes de que confirmes nada.
      </p>

      <h3>Condiciones de uso</h3>

      <p>
        El uso de worthline se rige por los{" "}
        <a href="/legal/terminos">términos de servicio</a>, la{" "}
        <a href="/legal/privacidad">política de privacidad</a> y la{" "}
        <a href="/legal/reembolsos">política de reembolsos</a>.
      </p>

      <h3>Código y seguridad</h3>

      <p>
        worthline es software libre: su código está publicado en{" "}
        <a
          href="https://github.com/jenarvaezg/worthline"
          rel="noreferrer noopener"
          target="_blank"
        >
          github.com/jenarvaezg/worthline
        </a>{" "}
        bajo licencia AGPL-3.0. Los avisos de seguridad se atienden por el canal descrito
        en su{" "}
        <a
          href="https://github.com/jenarvaezg/worthline/security/policy"
          rel="noreferrer noopener"
          target="_blank"
        >
          política de seguridad
        </a>
        .
      </p>
    </>
  );
}
