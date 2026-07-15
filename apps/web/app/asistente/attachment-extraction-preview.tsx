import Link from "next/link";

import type { AttachmentPreviewData } from "./attachment-chat";
import { wizardPrefillHref } from "./attachment-wizard-prefill";

const number = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 });
const euros = new Intl.NumberFormat("es-ES", {
  currency: "EUR",
  style: "currency",
});

export default function AttachmentExtractionPreview({
  preview,
}: {
  preview: AttachmentPreviewData;
}) {
  if (preview.result.status !== "valid") {
    return (
      <section className="assistantAttachmentPreview" role="status">
        <strong>Lectura de {preview.fileName}</strong>
        <p>{preview.result.message}</p>
      </section>
    );
  }

  const { data } = preview.result;
  return (
    <section
      aria-label={`Lectura de ${preview.fileName}`}
      aria-live="polite"
      className="assistantAttachmentPreview"
      role="status"
    >
      <strong>Lectura de {preview.fileName}</strong>
      <div className="assistantAttachmentTableScroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Posición</th>
              <th scope="col">Unidades</th>
              <th scope="col">Valor EUR</th>
              <th scope="col">Divisa</th>
              <th scope="col">Al alta</th>
            </tr>
          </thead>
          <tbody>
            {data.positions.map((position, index) => (
              <tr key={`${position.ticker}-${index}`}>
                <th scope="row">
                  {position.ticker} · {position.name}
                  {position.uncertain ? <em>Revisar lectura</em> : null}
                </th>
                <td>{number.format(position.units)}</td>
                <td>{euros.format(position.marketValueEur)}</td>
                <td>{position.currency}</td>
                <td>
                  <Link
                    className="actionLink"
                    href={wizardPrefillHref(position)}
                    prefetch={false}
                  >
                    Llevar al alta
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
          {data.totalEur !== undefined ? (
            <tfoot>
              <tr>
                <th colSpan={2} scope="row">
                  Total
                </th>
                <td>
                  <span className="totalRule">{euros.format(data.totalEur)}</span>
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <p className="assistantAttachmentBridgeHint">
        Revisa cada lectura. «Llevar al alta» abre el asistente de alta con los datos
        rellenos para que confirmes tú; nada se guarda desde el chat.
      </p>
      {data.warnings.length > 0 ? (
        <div className="assistantAttachmentWarnings">
          <span>Avisos</span>
          <ul>
            {data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
