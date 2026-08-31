import { ContactEmail } from "@web/legal/legal-contact";
import type { LegalDocumentProps } from "@web/legal/legal-documents";

/**
 * Aviso de no asesoramiento (#1172) — el texto que mantiene worthline fuera del
 * perímetro de la CNMV, alineado con el ADR 0045 (la IA es un asistente, no un
 * asesor).
 *
 * La línea la marca la «recomendación personalizada»: según la guía de la CNMV,
 * para que exista asesoramiento en materia de inversión deben darse cuatro
 * requisitos **acumulativos** (opinión, instrumento concreto, personalizada,
 * canal no genérico). worthline informa, explica y calcula sobre la cartera del
 * propio usuario, así que falla al menos el primero y el tercero. El párrafo
 * central reproduce la redacción acordada en el research #1136.
 */
export default function NoAsesoramientoDocument({ identity }: LegalDocumentProps) {
  return (
    <>
      <h2>Aviso de no asesoramiento</h2>

      <p className="legalLede">
        worthline es una <strong>herramienta de seguimiento e información</strong> sobre
        tu patrimonio. No presta asesoramiento en materia de inversión ni{" "}
        <strong>recomendaciones personalizadas</strong> de compra o venta de productos
        financieros, <strong>no ejecuta operaciones ni custodia fondos</strong>. La
        información y los cálculos que ofrece —incluidos los del asistente— tienen{" "}
        <strong>carácter meramente informativo</strong> y no deben interpretarse como
        consejo de inversión; las decisiones son responsabilidad del usuario.
      </p>

      <h3>Qué hace worthline</h3>

      <ul>
        <li>
          Registra los activos y las deudas que tú declaras, y calcula tu patrimonio neto,
          su evolución y sus retornos.
        </li>
        <li>
          Explica de dónde sale cada cifra: toda cifra es trazable hasta el dato que la
          origina.
        </li>
        <li>
          Proyecta escenarios con los supuestos que tú fijas (por ejemplo, en la pantalla
          FIRE). Son cálculos sobre tus hipótesis, no previsiones ni promesas de
          rentabilidad.
        </li>
      </ul>

      <h3>Qué no hace</h3>

      <ul>
        <li>
          No recomienda comprar, vender ni mantener ningún instrumento financiero
          concreto, ni presenta ninguna opción como idónea para tus circunstancias
          personales.
        </li>
        <li>No recibe, transmite ni ejecuta órdenes.</li>
        <li>No custodia dinero ni valores, ni tiene acceso a tus cuentas.</li>
        <li>No gestiona carteras por delegación.</li>
      </ul>

      <p>
        Por eso worthline <strong>no</strong> presta ninguno de los servicios de inversión
        sujetos a autorización y supervisión de la <strong>CNMV</strong>, ni realiza{" "}
        <strong>asesoramiento en materia de inversión</strong> en el sentido de la
        normativa del mercado de valores. Si buscas una recomendación adaptada a tu
        situación, acude a una entidad autorizada; puedes comprobar quién lo está en los
        registros oficiales de la CNMV.
      </p>

      <h3>El asistente</h3>

      <p>
        El asistente de worthline responde con tus propios datos y cita su origen. Puede
        leer, explicar y calcular, y puede proponerte apuntes para que tú los confirmes;
        no emite juicios sobre qué te conviene invertir. Como todo sistema basado en
        modelos de lenguaje, puede equivocarse: revisa siempre las cifras antes de tomar
        una decisión, y no le pidas —ni des por válida— una recomendación de inversión.
      </p>

      <h3>Rentabilidades pasadas</h3>

      <p>
        Los retornos y las series históricas que muestra worthline describen lo que ya ha
        ocurrido con tus posiciones. Las rentabilidades pasadas no garantizan
        rentabilidades futuras, y las valoraciones dependen de datos de terceros que
        pueden estar incompletos o desactualizados: la aplicación marca la frescura de
        cada precio para que puedas juzgarlo.
      </p>

      <h3>Dudas</h3>

      <p>
        Si algo de este aviso no queda claro, escribe a{" "}
        <ContactEmail identity={identity} />. Este aviso forma parte de los{" "}
        <a href="/legal/terminos">términos de servicio</a>.
      </p>
    </>
  );
}
