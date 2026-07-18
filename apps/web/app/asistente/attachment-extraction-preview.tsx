import Link from "next/link";

import type { AttachmentPreviewData } from "./attachment-chat";
import type {
  ExtractedBalanceSeriesDocument,
  ExtractedPositionsDocument,
  ExtractedPositionsMovementsDocument,
  HoldingFidelity,
} from "./attachment-extraction-contract";
import { wizardPrefillHref } from "./attachment-wizard-prefill";

const number = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 });
const euros = new Intl.NumberFormat("es-ES", {
  currency: "EUR",
  style: "currency",
});

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-ES", { currency, style: "currency" }).format(amount);
  } catch {
    // A currency the runtime cannot format still reads honestly as number + code.
    return `${number.format(amount)} ${currency}`;
  }
}

function PositionsPreview({ data }: { data: ExtractedPositionsDocument }) {
  return (
    <>
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
    </>
  );
}

function BalanceSeriesPreview({ data }: { data: ExtractedBalanceSeriesDocument }) {
  return (
    <>
      <div className="assistantAttachmentTableScroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Saldo</th>
              <th scope="col">Divisa</th>
            </tr>
          </thead>
          <tbody>
            {data.balances.map((balance, index) => (
              <tr key={`${balance.date}-${index}`}>
                <th scope="row">
                  {balance.date}
                  {balance.uncertain ? <em>Revisar lectura</em> : null}
                </th>
                <td>{formatAmount(balance.amount, balance.currency)}</td>
                <td>{balance.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="assistantAttachmentBridgeHint">
        Son los saldos fechados leídos del documento. Revísalos: nada se guarda desde el
        chat.
      </p>
    </>
  );
}

const FIDELITY_LABEL: Record<HoldingFidelity, string> = {
  declared_cost: "Coste declarado",
  movements: "Coste real",
  value_only: "Sin coste real",
};

function PositionsMovementsPreview({
  data,
}: {
  data: ExtractedPositionsMovementsDocument;
}) {
  return (
    <>
      <div className="assistantAttachmentTableScroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Posición</th>
              <th scope="col">Tipo</th>
              <th scope="col">Valor</th>
              <th scope="col">Divisa</th>
              <th scope="col">Fidelidad</th>
            </tr>
          </thead>
          <tbody>
            {data.holdings.map((holding, index) => (
              <tr key={`${holding.name}-${index}`}>
                <th scope="row">
                  {holding.name}
                  {holding.uncertain ? <em>Revisar lectura</em> : null}
                </th>
                <td>{holding.type}</td>
                <td>{formatAmount(holding.value, holding.currency)}</td>
                <td>{holding.currency}</td>
                <td>{FIDELITY_LABEL[holding.fidelity]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="assistantAttachmentBridgeHint">
        {data.movements.length > 0
          ? `Leídas ${data.holdings.length} posiciones y ${data.movements.length} movimientos. `
          : `Leídas ${data.holdings.length} posiciones. `}
        «Sin coste real» marca las que sólo traen su valor actual. Revísalas: nada se
        guarda desde el chat.
      </p>
    </>
  );
}

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
      {data.documentType === "positions" ? (
        <PositionsPreview data={data} />
      ) : data.documentType === "balance_series" ? (
        <BalanceSeriesPreview data={data} />
      ) : (
        <PositionsMovementsPreview data={data} />
      )}
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
