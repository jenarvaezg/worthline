import {
  ContactEmail,
  PendingIdentityNotice,
  PendingValue,
} from "@web/legal/legal-contact";
import type { LegalDocumentProps } from "@web/legal/legal-documents";
import { MERCHANT_OF_RECORD } from "@web/legal/legal-identity";
import { LEGAL_PROCESSORS } from "@web/legal/legal-processors";

/**
 * Política de privacidad (#1172) — RGPD arts. 13-14 y LOPDGDD.
 *
 * Puntos que el research #1136 y las decisiones cerradas obligan a decir:
 *
 *  - **bases jurídicas**: ejecución del contrato (art. 6.1.b) para el núcleo,
 *    interés legítimo (art. 6.1.f) para seguridad y abuso; sin analítica ni
 *    marketing no hace falta consentimiento para nada del núcleo;
 *  - **encargados** (`legal-processors.ts`) y **transferencias** a EE. UU. al
 *    amparo del Data Privacy Framework y/o cláusulas contractuales tipo;
 *  - la **cesión de contexto financiero a los proveedores LLM**, con qué se envía,
 *    para qué, y que ninguno entrena con esos datos;
 *  - la **promesa afinada de medición** de #1131 (sin telemetría de uso; solo lo
 *    mínimo para operar, incluidos `onboarded_at` y `first_holding_at`);
 *  - **derechos** ejercidos con lo que el producto ya tiene: exportación
 *    (acceso/portabilidad) y borrado del workspace (supresión), plazo de un mes;
 *  - **cookies**: solo técnicas, por eso no hay banner (art. 22.2 LSSI + guía
 *    de la AEPD).
 */
export default function PrivacidadDocument({ identity }: LegalDocumentProps) {
  return (
    <>
      <h2>Política de privacidad</h2>

      <p className="legalLede">
        worthline trata datos muy personales: lo que tienes y lo que debes. Esta política
        dice exactamente qué se guarda, por qué, quién más lo ve y cómo te lo llevas o lo
        borras. Sin letra pequeña.
      </p>

      <PendingIdentityNotice identity={identity} />

      <h3>1. Responsable del tratamiento</h3>

      <p>
        El responsable es {identity.operatorName ?? <PendingValue />}
        {identity.taxId ? <> (NIF {identity.taxId})</> : null}, identificado en el{" "}
        <a href="/legal/aviso-legal">aviso legal</a>. Para cualquier asunto relacionado
        con tus datos, incluido el ejercicio de tus derechos, escribe a{" "}
        <ContactEmail identity={identity} />.
      </p>

      <p>
        No hay obligación de nombrar un delegado de protección de datos: worthline no hace
        observación sistemática a gran escala y los datos patrimoniales, aunque sensibles
        en sentido corriente, no son «categorías especiales» del artículo 9 del RGPD.
      </p>

      <h3>2. Qué datos se tratan</h3>

      <ul>
        <li>
          <strong>Identidad de la cuenta</strong>: el correo con el que inicias sesión y
          el identificador que devuelve el proveedor de autenticación.
        </li>
        <li>
          <strong>Contenido de tu workspace</strong>: los activos, deudas, operaciones,
          valoraciones, objetivos y supuestos que registras, junto con los documentos que
          decidas adjuntar.
        </li>
        <li>
          <strong>Plan y facturación</strong>: qué plan tienes, desde cuándo, y los
          identificadores de la transacción que devuelve el vendedor de registro. Los
          datos de tu tarjeta no llegan nunca a worthline.
        </li>
        <li>
          <strong>Marcas de tiempo mínimas de operación</strong>: cuándo se creó tu
          workspace, cuándo se completó el <strong>onboarding completado</strong> y cuándo
          registraste tu primera posición. Dicen <em>que</em> ocurrió, nunca <em>qué</em>{" "}
          hay dentro.
        </li>
        <li>
          <strong>Errores técnicos</strong>: cuando el registro de errores esté activo
          (ver la tabla del apartado 4), el informe del fallo, con los datos personales
          filtrados antes de enviarse.
        </li>
      </ul>

      <p>
        worthline funciona <strong>sin telemetría de uso ni analytics de terceros</strong>
        : no se miden páginas vistas, ni clics, ni el contenido de tu patrimonio. Solo se
        registra lo mínimo para operar el servicio: cuenta, plan y pago, las marcas de
        tiempo de arriba y los errores técnicos.
      </p>

      <h3>3. Con qué base jurídica y para qué</h3>

      <ul>
        <li>
          <strong>Ejecución del contrato</strong> (<strong>artículo 6.1.b</strong> del
          RGPD): prestarte el servicio. Sin tratar los datos de tu patrimonio no hay nada
          que calcular ni mostrar.
        </li>
        <li>
          <strong>Interés legítimo</strong> (<strong>artículo 6.1.f</strong>): seguridad
          del servicio, corrección de errores y prevención de abuso y fraude.
        </li>
        <li>
          <strong>Obligación legal</strong>: conservar los registros contables y fiscales
          de las ventas durante los plazos que marca la ley.
        </li>
      </ul>

      <p>
        Como no hay publicidad, perfilado ni analítica,{" "}
        <strong>no pedimos consentimiento</strong> para nada del funcionamiento básico: no
        hay nada opcional que aceptar.
      </p>

      <h3>4. Quién más trata tus datos</h3>

      <p>
        worthline se apoya en proveedores que actúan como{" "}
        <strong>encargados del tratamiento</strong> (artículo 28 del RGPD), cada uno con
        su acuerdo de tratamiento firmado y solo para lo que se indica:
      </p>

      <div className="legalTableWrap">
        <table className="legalTable">
          <thead>
            <tr>
              <th scope="col">Proveedor</th>
              <th scope="col">Para qué</th>
              <th scope="col">Amparo</th>
            </tr>
          </thead>
          <tbody>
            {LEGAL_PROCESSORS.map((processor) => (
              <tr key={processor.name}>
                <th scope="row">
                  {processor.name}
                  {processor.active === false ? (
                    <>
                      {" "}
                      <span className="legalPending">(aún no activo)</span>
                    </>
                  ) : null}
                </th>
                <td>{processor.purpose}</td>
                <td>{processor.mechanism}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        Los marcados <strong>«aún no activo»</strong> están declarados porque entrarán con
        la función que los usa (el correo transaccional y el registro de errores);
        mientras tanto <strong>no reciben ningún dato</strong>. Esta página se actualizará
        el día que empiecen a recibirlo.
      </p>

      <p>
        Además, <strong>{MERCHANT_OF_RECORD.name}</strong> trata los datos del pago como{" "}
        <strong>vendedor de registro</strong> —es decir, como responsable propio de esa
        transacción, no como encargado nuestro— según su{" "}
        <a href={MERCHANT_OF_RECORD.privacyUrl} rel="noreferrer noopener" target="_blank">
          política de privacidad
        </a>
        .
      </p>

      <p>No se venden ni se ceden tus datos a nadie más, y no se usan para publicidad.</p>

      <h3>5. Transferencias fuera de la Unión Europea</h3>

      <p>
        Los proveedores de la tabla están en <strong>Estados Unidos</strong>. Esas
        transferencias se amparan en la decisión de adecuación del{" "}
        <strong>Data Privacy Framework</strong> cuando el proveedor está certificado y, en
        todo caso o como respaldo, en las <strong>cláusulas</strong> contractuales tipo de
        la Comisión Europea incluidas en el acuerdo de tratamiento de cada uno.
      </p>

      <h3>6. El asistente y los modelos de lenguaje</h3>

      <p>
        Cuando usas el asistente, worthline envía al proveedor del modelo el{" "}
        <strong>contexto financiero</strong> necesario para responderte: las cifras y
        posiciones relevantes de tu pregunta, y el documento que hayas adjuntado si pides
        que lo lea. Ocurre <strong>solo cuando escribes al asistente</strong>: si no lo
        usas, tus datos no salen por ahí.
      </p>

      <p>
        Los proveedores del asistente <strong>no entrenan</strong> sus modelos con lo que
        se les envía ni con lo que responden, según sus condiciones para uso por API.
        worthline <strong>no guarda</strong> la conversación: el hilo vive en tu navegador
        mientras tienes el panel abierto y desaparece al cerrarlo. Lo que sí queda, si
        confirmas una propuesta del asistente, es el apunte que se escribe en tu workspace
        — como cualquier otro dato que registres tú.
      </p>

      <h3>7. Cuánto tiempo se conservan</h3>

      <p>
        El contenido de tu workspace se conserva mientras la cuenta exista; cuando lo
        eliminas, se borra. Los registros de facturación se conservan el tiempo que exigen
        las obligaciones contables y fiscales. Los informes de error se conservan un plazo
        corto, el necesario para diagnosticar el fallo.
      </p>

      <h3>8. Tus derechos</h3>

      <p>
        Puedes ejercer los derechos de acceso, rectificación, supresión, limitación,
        oposición y portabilidad. Dos de ellos están a un clic dentro de la aplicación,
        sin pedirle permiso a nadie:
      </p>

      <ul>
        <li>
          <strong>Acceso y portabilidad</strong>: la <strong>exportación</strong> completa
          de tu workspace en un fichero legible por máquina, desde Ajustes.
        </li>
        <li>
          <strong>Supresión</strong>: <strong>eliminar el workspace</strong> completo,
          también desde Ajustes. Es inmediato e irreversible.
        </li>
      </ul>

      <p>
        Para el resto, o si prefieres que lo hagamos nosotros, escribe a{" "}
        <ContactEmail identity={identity} />: se responde en el plazo de{" "}
        <strong>un mes</strong> que marca el RGPD. Si crees que no se ha atendido bien,
        puedes reclamar ante la <strong>Agencia Española de Protección de Datos</strong> (
        <a href="https://www.aepd.es" rel="noreferrer noopener" target="_blank">
          aepd.es
        </a>
        ).
      </p>

      <h3>9. Cookies</h3>

      <p>
        worthline usa únicamente <strong>cookies técnicas</strong> necesarias para el
        inicio de sesión, la seguridad y las preferencias que tú eliges (como el ámbito o
        el modo privacidad). No hay cookies de analítica ni de publicidad, y por eso{" "}
        <strong>no mostramos un banner</strong> de consentimiento: no hay nada que
        consentir. Si algún día entrara algo que no esté exento, se pedirá consentimiento
        antes.
      </p>

      <h3>10. Seguridad y brechas</h3>

      <p>
        Cada workspace vive en su propia base de datos, las credenciales de acceso a los
        datos se guardan cifradas y el acceso está siempre detrás de la sesión. Si
        ocurriera una brecha de seguridad con riesgo para tus derechos, se notificará a la
        autoridad de control en el plazo de 72 horas y, si el riesgo es alto, también a ti
        sin dilación indebida.
      </p>

      <h3>11. Cambios en esta política</h3>

      <p>
        Si esta política cambia de forma relevante, se avisará en la aplicación o por
        correo antes de que el cambio surta efecto. La fecha de la última revisión aparece
        al final de esta página.
      </p>
    </>
  );
}
