import Link from "next/link";

import type { AttachmentPreviewCard } from "./attachment-chat";
import type {
  DeclaredEffectKind,
  ExtractedBalanceSeriesDocument,
  ExtractedHoldingEventDocument,
  ExtractedPositionsDocument,
  ExtractedPositionsMovementsDocument,
  HoldingEventKind,
  HoldingFidelity,
} from "./attachment-extraction-contract";
import { wizardPrefillHref } from "./attachment-wizard-prefill";
import { formatIsoDayEs } from "./iso-day-es";

const number = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 });
const euros = new Intl.NumberFormat("es-ES", {
  currency: "EUR",
  style: "currency",
});

/**
 * An amount in its own currency. `maximumFractionDigits` widens the currency's own
 * default for a figure the document printed with more precision than money usually
 * carries — a fund NAV of 12,3456 € rounded to two decimals would be a figure this
 * card invented, and rounding is the one thing the reading may not do.
 */
function formatAmount(
  amount: number,
  currency: string,
  options: { maximumFractionDigits?: number } = {},
): string {
  try {
    return new Intl.NumberFormat("es-ES", {
      currency,
      style: "currency",
      ...options,
    }).format(amount);
  } catch {
    // A currency the runtime cannot format still reads honestly as number + code.
    return `${number.format(amount)} ${currency}`;
  }
}

/**
 * A position that printed neither symbol nor units — the ordinary row of a bank's
 * composition tab. It is not an incomplete reading and the card must not paint it as one:
 * what it means is that the alta goes in by its total value (#1325), which is what the
 * hint below says once any row arrives this way.
 */
function isValueOnly(position: ExtractedPositionsDocument["positions"][number]): boolean {
  return position.units === undefined && position.ticker === undefined;
}

function PositionsPreview({ data }: { data: ExtractedPositionsDocument }) {
  const someValueOnly = data.positions.some(isValueOnly);
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
              <tr key={`${position.ticker ?? position.name}-${index}`}>
                <th scope="row">
                  {position.ticker === undefined
                    ? position.name
                    : `${position.ticker} · ${position.name}`}
                  {position.uncertain ? <em>Revisar lectura</em> : null}
                </th>
                {/* «—» and not a blank cell: the document printed no units, and saying so
                    is different from a reading that failed to fill the column. */}
                <td>
                  {position.units === undefined ? "—" : number.format(position.units)}
                </td>
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
        {someValueOnly
          ? "Las filas sin participaciones («—») son las que el documento da solo por su valor: se llevan al alta por ese importe, como 1 participación a ese precio. "
          : ""}
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

/**
 * How each `kind` reads. It is the ONE field on this card the model classified
 * rather than read, so the row is labelled as a reading of ours and the copy under
 * the table says so — an amount sitting next to an authoritative «Amortización
 * anticipada» the screen never wrote is precisely the invention ADR 0048 forbids.
 */
const HOLDING_EVENT_KIND_LABEL: Record<HoldingEventKind, string> = {
  deposit: "Ingreso",
  early_repayment: "Amortización anticipada",
  fee: "Comisión",
  interest: "Intereses",
  other: "Movimiento",
  payment: "Pago",
  withdrawal: "Retirada",
};

/**
 * How the screen's declared effect reads. Present tense and no figure of our own:
 * the amount, when the document gave one, is rendered next to it verbatim. Nothing
 * here claims the effect HAS happened in worthline — it is what the document says.
 */
const DECLARED_EFFECT_LABEL: Record<DeclaredEffectKind, string> = {
  balance_reduced: "Reduce el saldo pendiente",
  final_instalment_reduced: "Reduce la última cuota",
  instalment_reduced: "Reduce la cuota",
  term_shortened: "Acorta el plazo",
};

/**
 * One dated fact read off a screen (#1244). Rendered as a label/value table rather
 * than the row-per-item tables of the other documents because the document IS one
 * fact — and it stays one by contract, which is what keeps the validated door from
 * becoming a bulk-import lane (#1248).
 *
 * Only observed fields get a row: an absent declared effect, next instalment or trade
 * figure (#1316) paints nothing at all, never a dash that could read as «no hay». The
 * card is where the user CONFIRMS the reading, so every field the contract carries
 * must be visible here — a value the agent can act on but the user never saw would
 * make the confirmation a formality.
 */
function HoldingEventPreview({ data }: { data: ExtractedHoldingEventDocument }) {
  const { event } = data;
  return (
    <>
      <div className="assistantAttachmentTableScroll">
        <table>
          <tbody>
            <tr>
              <th scope="row">Fecha</th>
              <td>{formatIsoDayEs(event.date)}</td>
            </tr>
            <tr>
              <th scope="row">Concepto</th>
              <td>
                {event.label}
                {event.uncertain ? <em>Revisar lectura</em> : null}
              </td>
            </tr>
            {event.isin ? (
              <tr>
                <th scope="row">ISIN</th>
                <td>{event.isin}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">Importe</th>
              <td>{formatAmount(event.amount, event.currency)}</td>
            </tr>
            {event.units !== undefined ? (
              <tr>
                <th scope="row">Títulos</th>
                <td>{number.format(event.units)}</td>
              </tr>
            ) : null}
            {event.pricePerUnit ? (
              <tr>
                <th scope="row">Precio por título</th>
                <td>
                  {formatAmount(
                    event.pricePerUnit.amount,
                    event.pricePerUnit.currency,
                    // The document's own precision, never rounded down to two.
                    { maximumFractionDigits: 4 },
                  )}
                </td>
              </tr>
            ) : null}
            {event.fees ? (
              <tr>
                <th scope="row">Comisión</th>
                <td>{formatAmount(event.fees.amount, event.fees.currency)}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">Tipo</th>
              <td>{HOLDING_EVENT_KIND_LABEL[event.kind]}</td>
            </tr>
            {event.declaredEffect ? (
              <tr>
                <th scope="row">Efecto declarado</th>
                <td>
                  {DECLARED_EFFECT_LABEL[event.declaredEffect.kind]}
                  {event.declaredEffect.amount !== undefined &&
                  event.declaredEffect.currency !== undefined
                    ? ` · ${formatAmount(event.declaredEffect.amount, event.declaredEffect.currency)}`
                    : ""}
                </td>
              </tr>
            ) : null}
            {event.nextInstalment ? (
              <tr>
                <th scope="row">Próxima cuota</th>
                <td>
                  {formatIsoDayEs(event.nextInstalment.date)} ·{" "}
                  {formatAmount(
                    event.nextInstalment.amount,
                    event.nextInstalment.currency,
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="assistantAttachmentBridgeHint">
        {data.uncertain ? "Lectura completa marcada como dudosa. " : ""}
        Fecha, concepto, importe y los datos de la operación se leen del archivo; «Tipo»
        es una clasificación de la lectura, no algo que ponga la pantalla. El apunte no
        dice a qué producto pertenece ni qué saldo deja: eso se comprueba aparte.
        Revísalo: nada se guarda desde el chat.
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

/**
 * The whole card for everything that is not a rendered document: a file name and one
 * honest sentence. It serves the three message-only verdicts AND the degraded payload
 * of a client that predates the server's card (#1261) — one markup for both, because
 * the user's need is identical and there is nothing extra to say about the second.
 */
function MessageOnlyCard({ fileName, message }: { fileName: string; message: string }) {
  return (
    <section className="assistantAttachmentPreview" role="status">
      <strong>Lectura de {fileName}</strong>
      <p>{message}</p>
    </section>
  );
}

export default function AttachmentExtractionPreview({
  card,
}: {
  card: AttachmentPreviewCard;
}) {
  if (card.kind === "degraded") {
    return <MessageOnlyCard fileName={card.fileName} message={card.message} />;
  }
  if (card.result.status !== "valid") {
    return <MessageOnlyCard fileName={card.fileName} message={card.result.message} />;
  }

  const { data } = card.result;
  return (
    <section
      aria-label={`Lectura de ${card.fileName}`}
      aria-live="polite"
      className="assistantAttachmentPreview"
      role="status"
    >
      <strong>Lectura de {card.fileName}</strong>
      {data.documentType === "positions" ? (
        <PositionsPreview data={data} />
      ) : data.documentType === "balance_series" ? (
        <BalanceSeriesPreview data={data} />
      ) : data.documentType === "holding_event" ? (
        <HoldingEventPreview data={data} />
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
