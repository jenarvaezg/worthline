import { ContactEmail } from "@web/legal/legal-contact";
import type { LegalDocumentProps } from "@web/legal/legal-documents";
import { MERCHANT_OF_RECORD } from "@web/legal/legal-identity";

/**
 * Términos de servicio (#1172).
 *
 * Reparto de papeles del research #1136: el merchant of record es el vendedor de
 * registro del **pago** (su checkout, su factura, sus reembolsos); estos términos
 * rigen el **uso del software**. Dos cláusulas no son opcionales porque vienen de
 * decisiones ya cerradas:
 *
 *  - el **wind-down honesto del lifetime** (#1132): acceso mientras el servicio
 *    esté alojado, aviso con ~30 días, exportación disponible y reembolso a
 *    petición — el compromiso moral escrito como obligación contractual;
 *  - las **salvedades de beta** limitan expectativas, no derechos: frente a un
 *    consumidor no se pueden excluir las garantías legales imperativas del
 *    TRLGDCU (Real Decreto Legislativo 1/2007) ni la responsabilidad por dolo o
 *    negligencia grave.
 */
export default function TerminosDocument({ identity }: LegalDocumentProps) {
  return (
    <>
      <h2>Términos de servicio</h2>

      <p className="legalLede">
        Estos términos rigen el uso de worthline. Están escritos para leerse: si alguna
        cláusula te parece confusa, escribe a <ContactEmail identity={identity} /> y la
        aclaramos o la corregimos.
      </p>

      <h3>1. Qué es worthline</h3>

      <p>
        worthline es una aplicación web de seguimiento del patrimonio personal y familiar.
        Registras tus activos y tus deudas y la aplicación calcula tu patrimonio neto, su
        histórico, sus retornos y proyecciones sobre los supuestos que tú fijas.
      </p>

      <p>
        worthline <strong>no custodia</strong> dinero ni valores,{" "}
        <strong>no ejecuta órdenes</strong>, no se conecta a tus cuentas bancarias y{" "}
        <strong>no presta asesoramiento</strong> en materia de inversión (ver el{" "}
        <a href="/legal/no-asesoramiento">aviso de no asesoramiento</a>, que forma parte
        de estos términos). Los datos que entran son los que tú declaras o los que
        autorizas a importar.
      </p>

      <h3>2. Cuenta y elegibilidad</h3>

      <p>
        Para usar worthline necesitas ser mayor de edad y tener capacidad para contratar.
        Se accede con una cuenta de Google; eres responsable de mantener el control de esa
        cuenta y de la veracidad de los datos que registres. Cada workspace vive en su
        propia base de datos y solo es accesible por quien lo ha creado y por quien esa
        persona invite.
      </p>

      <h3>3. Planes, pago y facturación</h3>

      <p>
        worthline ofrece un plan gratuito, un plan premium por suscripción y una compra
        única «lifetime». Lo que cada plan incluye se describe en la propia aplicación en
        el momento de contratar. El seguimiento manual y la lectura de tus propios datos
        son gratuitos y no dependen de que pagues.
      </p>

      <p>
        El cobro no lo hace worthline: las suscripciones y las compras se cursan a través
        de <strong>{MERCHANT_OF_RECORD.name}</strong>, que actúa como{" "}
        <strong>vendedor de registro</strong>. Es quien te vende, quien emite la{" "}
        <strong>factura con el IVA</strong> que corresponda a tu país de residencia y
        quien procesa los reembolsos, conforme a sus{" "}
        <a href={MERCHANT_OF_RECORD.termsUrl} rel="noreferrer noopener" target="_blank">
          condiciones para compradores
        </a>
        . Estos términos no las contradicen: rigen el uso del software, no la transacción
        económica.
      </p>

      <p>
        La suscripción se renueva por el periodo contratado hasta que la canceles, y
        puedes cancelarla en cualquier momento desde la propia aplicación. Los reembolsos
        y el derecho de desistimiento están en la{" "}
        <a href="/legal/reembolsos">política de reembolsos</a>.
      </p>

      <h3>4. El compromiso del plan lifetime</h3>

      <p>
        El plan lifetime da acceso a las funciones premium{" "}
        <strong>mientras el servicio siga alojado y operativo</strong>. No es una promesa
        de eternidad, y no vamos a fingir que lo sea. Si worthline dejara de prestarse
        como servicio alojado:
      </p>

      <ul>
        <li>
          se avisará <strong>con al menos 30 días de antelación</strong>, por correo y en
          la propia aplicación;
        </li>
        <li>
          la <strong>exportación</strong> completa de tus datos seguirá disponible durante
          todo ese plazo, y el código seguirá publicado para que puedas alojarlo tú;
        </li>
        <li>
          a quien lo pida se le <strong>reembolsará</strong> la compra lifetime de forma
          íntegra o proporcional según el tiempo transcurrido, sin discusiones.
        </li>
      </ul>

      <p>
        Este compromiso es contractual, no una declaración de intenciones: forma parte de
        lo que compras al comprar el lifetime.
      </p>

      <h3>5. Servicio en beta y sin SLA</h3>

      <p>
        worthline se presta <strong>tal cual</strong> y en versión <strong>beta</strong>:
        puede contener funciones en pruebas que cambien o se retiren, y lo mantiene una
        sola persona <strong>sin un acuerdo de nivel de servicio</strong> — no se promete
        disponibilidad, tiempo de respuesta ni cadencia de novedades. El soporte se
        atiende por correo en <ContactEmail identity={identity} /> y en las incidencias
        públicas del repositorio, lo antes que sea posible.
      </p>

      <p>
        Esta salvedad limita expectativas, no tus derechos: frente a personas consumidoras
        no se excluyen ni limitan las <strong>garantías legales</strong> imperativas del{" "}
        <strong>Real Decreto Legislativo 1/2007</strong> (texto refundido de la Ley
        General para la Defensa de los Consumidores y Usuarios) ni la responsabilidad por
        dolo o negligencia grave.
      </p>

      <h3>6. Tus datos y tu contenido</h3>

      <p>
        Los datos que registras son tuyos. worthline los trata para prestarte el servicio
        en los términos de la <a href="/legal/privacidad">política de privacidad</a>.
        Desde la propia aplicación puedes <strong>exportarlos</strong> en un fichero
        legible o <strong>eliminar el workspace completo</strong> en cualquier momento; al
        eliminarlo, los datos se borran y la operación no se puede deshacer.
      </p>

      <h3>7. Uso aceptable</h3>

      <p>
        No se permite usar worthline para actividades ilícitas, intentar acceder a datos
        de otras personas, saltarse los límites técnicos de la aplicación, automatizar un
        consumo desproporcionado de los recursos compartidos —en particular del asistente—
        ni revenderlo como servicio propio. Si un uso pone en riesgo el servicio para el
        resto, puede suspenderse la cuenta, avisando y con derecho a exportar los datos y
        a la parte no consumida de lo pagado.
      </p>

      <h3>8. Propiedad intelectual</h3>

      <p>
        El código de worthline es software libre bajo licencia <strong>AGPL-3.0</strong> y
        está publicado en{" "}
        <a
          href="https://github.com/jenarvaezg/worthline"
          rel="noreferrer noopener"
          target="_blank"
        >
          GitHub
        </a>
        : puedes leerlo, modificarlo y alojarlo tú en los términos de esa licencia. La
        marca y el nombre «worthline» no se ceden con la licencia del código. Tu contenido
        sigue siendo tuyo; no se usa para entrenar modelos ni se cede a terceros con fines
        distintos de prestarte el servicio.
      </p>

      <h3>9. Cambios en el servicio y en estos términos</h3>

      <p>
        worthline evoluciona: pueden añadirse, cambiar o retirarse funciones. Si un cambio
        en estos términos te afecta de forma relevante, se avisará con antelación
        razonable por correo o en la aplicación; si no lo aceptas, puedes cancelar y
        exportar tus datos. Los cambios no se aplican retroactivamente a lo ya pagado.
      </p>

      <h3>10. Cancelación</h3>

      <p>
        Puedes dejar de usar worthline cuando quieras. Al cancelar la suscripción
        conservas el acceso hasta el final del periodo pagado y después la cuenta pasa al
        plan gratuito, con tus datos intactos. Por nuestra parte, solo se cerraría una
        cuenta por un incumplimiento grave de estos términos o por el cese del servicio, y
        en ambos casos con aviso y con la exportación disponible.
      </p>

      <h3>11. Responsabilidad</h3>

      <p>
        worthline es una herramienta de información: las decisiones económicas que tomes
        son tuyas. Dentro de lo que la ley permite frente a personas consumidoras, no
        respondemos de decisiones de inversión, de datos que introduzcas mal, ni de la
        indisponibilidad de fuentes de precios de terceros. Nada en estos términos limita
        la responsabilidad que no puede limitarse por ley.
      </p>

      <h3>12. Ley aplicable y reclamaciones</h3>

      <p>
        Estos términos se rigen por la ley española. Si eres una persona consumidora,
        conservas el fuero que la ley te reserva: podrás reclamar ante los tribunales de
        tu <strong>domicilio del consumidor</strong> y te amparan las normas de protección
        de tu país de residencia en la Unión Europea. Antes de eso, escribe a{" "}
        <ContactEmail identity={identity} />: casi todo se resuelve por correo.
      </p>

      <h3>13. Textos relacionados</h3>

      <ul>
        <li>
          <a href="/legal/privacidad">Política de privacidad</a>
        </li>
        <li>
          <a href="/legal/reembolsos">Política de reembolsos</a>
        </li>
        <li>
          <a href="/legal/no-asesoramiento">Aviso de no asesoramiento</a>
        </li>
        <li>
          <a href="/legal/aviso-legal">Aviso legal</a>
        </li>
      </ul>
    </>
  );
}
