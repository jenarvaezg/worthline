"use client";

/**
 * The «Traspasar» surface (#1480, S3 of PRD #1393): one screen and one submit for a
 * traspaso, next to the operations ledger it is not part of.
 *
 * Why it is an island (ADR 0036, interaction-patterns §1/§4). Three things here have
 * to happen without a round trip: searching the workspace's own holdings for the
 * destination, seeing the participaciones that will leave and arrive as the importe
 * is typed, and prefilling the destination's VL from its cached price when the
 * destination changes. The participaciones are NOT guessed for the preview — it runs
 * `planTransfer`, the very function behind the write gate (`transfer-form.ts`), so
 * the figures on screen are the figures that get stored (#1438).
 *
 * What still works with no JS: everything that writes. The destination-creation pane
 * and the importe field are disclosed by CSS `:has()` (as the add wizard's drawers
 * are), the form keeps its server-action `action=`, and the server does the real
 * validation. What is lost without JS is the search box, the live preview and the
 * cached-price prefill — conveniences, not the flow.
 *
 * The mutation is NOT optimistic, on purpose (§4): what a traspaso changes is a pair
 * of positions, two costs and a re-rippled history, none of it predictable in the
 * client. A pending button that tells the truth beats a number that jumps.
 */

import { formatIsoDayEs } from "@web/asistente/iso-day-es";
import type { FormErrorContext } from "@web/intake";
import type { CurrencyCode } from "@worthline/domain";
import {
  derivePosition,
  formatMoneyMinorPrivacy,
  formatPrice,
  formatUnits,
  operationsUpTo,
} from "@worthline/domain";
import { type FormEvent, useRef, useState, useTransition } from "react";

import {
  NEW_DESTINATION,
  previewTransfer,
  readTransferFormValues,
  stampTransferSubmission,
  type TransferDestinationOption,
  type TransferFormValues,
  type TransferPreviewOrigin,
  type TransferReading,
  transferReading,
} from "./transfer-form";

/**
 * The submit button. Its own component because the island intercepts the submit and
 * calls the action by hand, which leaves `useFormStatus` idle — the same reason
 * `RecordOperationSubmit` exists for the operations form.
 */
function RecordTransferSubmit({
  disabled = false,
  pending,
}: {
  disabled?: boolean;
  pending: boolean;
}) {
  return (
    <button aria-busy={pending} disabled={pending || disabled} type="submit">
      {pending ? "Registrando…" : "Registrar traspaso"}
    </button>
  );
}

export default function TransferSection({
  archiveOrigin = false,
  currentUrl,
  destinations,
  formError,
  origin,
  originName,
  privacyMode = false,
  readOnly = false,
  recordAction,
  today,
}: {
  /**
   * Arrived here from the Papelera's «Lo traspasé a…» exit (#1549): the origin is on
   * its way to the trash, and this traspaso is the movement that explains where its
   * money went. The archive rides the SAME submit — a second gesture, later, is
   * exactly the one Groupama never got — and only happens if the traspaso leaves the
   * origin empty.
   */
  archiveOrigin?: boolean;
  currentUrl: string;
  /** The workspace's other investment holdings, already filtered by the server. */
  destinations: readonly TransferDestinationOption[];
  formError: FormErrorContext | null;
  /**
   * The origin's LEDGER plus its last known price. The ledger travels because the
   * preview folds it at the date the user picks — a position folded on the server
   * would be today's, and a backdated traspaso would preview figures the gate then
   * refuses (#1438).
   */
  origin: TransferPreviewOrigin & { pricePerUnit?: string };
  originName: string;
  privacyMode?: boolean;
  /** Demo: the write guard refuses, so the submit is disabled rather than lying (§10). */
  readOnly?: boolean;
  recordAction: (formData: FormData) => void | Promise<void>;
  today: string;
}) {
  const roundTripped = formError?.formId === "transfer" ? formError.values : {};
  const initial: TransferFormValues = {
    amount: roundTripped["amount"] ?? "",
    destinationAmount: roundTripped["destinationAmount"] ?? "",
    destinationAssetId: roundTripped["destinationAssetId"] ?? "",
    destinationPricePerUnit: roundTripped["destinationPricePerUnit"] ?? "",
    destinationUnits: roundTripped["destinationUnits"] ?? "",
    executedAt: roundTripped["executedAt"] ?? today,
    newDestinationIsin: roundTripped["newDestinationIsin"] ?? "",
    newDestinationName: roundTripped["newDestinationName"] ?? "",
    originPricePerUnit:
      roundTripped["originPricePerUnit"] ??
      (origin.pricePerUnit ? formatPrice(origin.pricePerUnit) : ""),
    originUnits: roundTripped["originUnits"] ?? "",
    portion: roundTripped["portion"] ?? "amount",
    // Participaciones by default (#1544): the ordinary reason someone is on this screen
    // is a justificante in hand, and that paper states the participaciones and the
    // importe of each leg — never the VL to the decimals the fund publishes.
    reading: roundTripped["reading"] ?? "units",
  };

  // The form's live values, read off the form itself rather than mirrored field by
  // field: the inputs stay uncontrolled (so the no-JS path and the round-tripped
  // `defaultValue`s are untouched) and the preview still updates on every keystroke.
  const [values, setValues] = useState<TransferFormValues>(initial);
  const [query, setQuery] = useState("");
  const [isRecording, startRecording] = useTransition();
  // The key of the submit in flight (#1394), so a second click in the same frame
  // reuses it and the server recognises the replay. Cleared when it settles, or a
  // legitimate second traspaso would be mistaken for a replay of the first.
  const inFlightSubmissionId = useRef<string | null>(null);
  // Whether the user has typed in the destination's VL. Until then, choosing a
  // destination prefills it from that holding's cached price; after, nothing
  // overwrites what a human typed.
  const destinationPriceTouched = useRef(false);
  const destinationPriceField = useRef<HTMLInputElement | null>(null);

  const preview = previewTransfer(values, origin, today);
  // The position «todo» would empty, at the date on the form — the same fold the
  // preview and the gate run, so the figure on the radio is the figure that leaves.
  const unitsOnDate = derivePosition(
    operationsUpTo(origin.operations, (values.executedAt || today).slice(0, 10)),
    { assetId: origin.assetId, currency: origin.currency },
  ).currentUnits;

  const readForm = (form: HTMLFormElement) =>
    setValues(readTransferFormValues(new FormData(form)));

  const onSubmit = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        stampTransferSubmission(formData, inFlightSubmissionId, () =>
          crypto.randomUUID(),
        );
        startRecording(async () => {
          try {
            await recordAction(formData);
          } finally {
            inFlightSubmissionId.current = null;
          }
        });
      };

  const onDestinationChange = (select: HTMLSelectElement) => {
    if (!destinationPriceTouched.current && destinationPriceField.current) {
      const chosen = destinations.find((option) => option.assetId === select.value);
      destinationPriceField.current.value = chosen?.pricePerUnit
        ? formatPrice(chosen.pricePerUnit)
        : "";
    }
    // Re-read the form AFTER the prefill: assigning `.value` fires no input event, so
    // without this the preview would keep last keystroke's destination VL — the
    // prefill would be invisible to the live figures until the next keypress.
    if (select.form) readForm(select.form);
  };

  const shown = destinations.filter(
    (option) =>
      option.assetId === values.destinationAssetId ||
      option.name.toLocaleLowerCase("es-ES").includes(query.toLocaleLowerCase("es-ES")),
  );

  return (
    <section aria-label="Traspaso a otra inversión" id="traspaso">
      <h3>Traspasar</h3>
      <p className="infoNote">
        Mueve participaciones de {originName} a otra inversión. Un traspaso no es una
        venta: no realiza plusvalía y no consume cupo de aportación.
      </p>

      {formError?.formId === "transfer" ? (
        <p className="errorBand" id="transfer-error" role="alert">
          {formError.message}
        </p>
      ) : null}

      {archiveOrigin ? (
        <p className="warningBand">
          Vienes de la Papelera: al registrar este traspaso, «{originName}» se irá a la
          Papelera si el traspaso lo deja sin participaciones.
        </p>
      ) : null}

      <form
        action={recordAction}
        aria-label="Traspasar a otra inversión"
        className="stackForm inversionesForm transferForm"
        onInput={(event) => readForm(event.currentTarget)}
        onSubmit={onSubmit}
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        {archiveOrigin ? <input name="archiveOrigin" type="hidden" value="1" /> : null}

        <label>
          Buscar entre tus inversiones <small>(opcional)</small>
          <input
            aria-label="Buscar la inversión de destino"
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            value={query}
          />
        </label>

        <label>
          Inversión de destino
          <select
            defaultValue={initial.destinationAssetId}
            name="destinationAssetId"
            onChange={(event) => onDestinationChange(event.target)}
          >
            <option value="">Elige una inversión…</option>
            {shown.map((option) => (
              <option key={option.assetId} value={option.assetId}>
                {option.name}
              </option>
            ))}
            <option value={NEW_DESTINATION}>+ Crear una inversión nueva…</option>
          </select>
        </label>

        {/* The «crear destino» pane. NEVER `required` on anything in here: this is
            one form with a hidden pane, and a native constraint inside
            `display:none` aborts the submit of the WHOLE form in a real browser,
            for every path — the trap #677 caught in the add wizard. What makes the
            name obligatory is the server (`parseTransferForm`). */}
        <div className="transferNewPane">
          <label>
            Nombre de la inversión de destino
            <input
              aria-label="Nombre de la inversión de destino"
              defaultValue={initial.newDestinationName}
              name="newDestinationName"
              placeholder="Cartera Permanente PP"
            />
          </label>
          <label>
            ISIN del destino <small>(opcional)</small>
            <input
              aria-label="ISIN de la inversión de destino"
              defaultValue={initial.newDestinationIsin}
              name="newDestinationIsin"
              placeholder="ES0173894017"
            />
          </label>
          <p className="opCaptureHint">
            La crearemos con los mismos dueños y el mismo tipo de producto que{" "}
            {originName}, y con el valor liquidativo del traspaso como precio: el que
            indiques abajo, o el que salga de las participaciones y el importe.
          </p>
        </div>

        <label>
          Fecha del traspaso
          <input
            aria-label="Fecha del traspaso"
            defaultValue={initial.executedAt}
            name="executedAt"
            type="date"
          />
        </label>

        <fieldset className="transferPortion">
          <legend>Cuánto se traspasa</legend>
          <label>
            <input
              defaultChecked={initial.portion !== "all"}
              name="portion"
              type="radio"
              value="amount"
            />{" "}
            Un importe
          </label>
          {/* «Todo» is its own intent, not an importe that happens to equal the
              position: only it empties the origin exactly, so it is a choice and not
              a button that fills the field in. */}
          <label>
            <input
              defaultChecked={initial.portion === "all"}
              name="portion"
              type="radio"
              value="all"
            />{" "}
            Todo ({formatUnits(unitsOnDate)} participaciones)
          </label>
        </fieldset>

        <label className="transferAmountField">
          Importe traspasado ({origin.currency})
          <input
            aria-label={`Importe traspasado en ${origin.currency}`}
            defaultValue={initial.amount}
            inputMode="decimal"
            name="amount"
            placeholder="739,22"
          />
        </label>

        {/* WHICH two figures per leg the user is copying (#1544). Participaciones by
            default: they are what the justificante prints, they are what the position
            IS, and a VL typed with fewer decimals than the fund publishes writes units
            that are permanently not the bank's. The other reading stays for the paper
            that states no participaciones. */}
        <fieldset className="transferPortion">
          <legend>Qué cifras tienes del justificante</legend>
          <label>
            <input
              defaultChecked={initial.reading !== "price"}
              name="reading"
              type="radio"
              value="units"
            />{" "}
            Las participaciones y el importe
          </label>
          <label>
            <input
              defaultChecked={initial.reading === "price"}
              name="reading"
              type="radio"
              value="price"
            />{" "}
            El importe y el valor liquidativo
          </label>
        </fieldset>

        <div className="transferUnitsPane">
          <label>
            Participaciones que salieron de {originName}
            <input
              aria-label="Participaciones que salieron del origen"
              defaultValue={initial.originUnits}
              inputMode="decimal"
              name="originUnits"
              placeholder="34,803202"
            />
          </label>
          <label>
            Participaciones que entraron en el destino
            <input
              aria-label="Participaciones que entraron en el destino"
              defaultValue={initial.destinationUnits}
              inputMode="decimal"
              name="destinationUnits"
              placeholder="2,317722"
            />
          </label>
          <p className="opCaptureHint">
            Cópialas tal cual del justificante, con todos sus decimales. El valor
            liquidativo de cada lado lo calculamos nosotros, así que no hace falta que lo
            busques.
          </p>
        </div>

        <div className="transferPricePane">
          <label>
            Valor liquidativo de origen el día del traspaso
            <input
              aria-label="Valor liquidativo de origen"
              defaultValue={initial.originPricePerUnit}
              inputMode="decimal"
              name="originPricePerUnit"
              placeholder="12,00"
            />
          </label>

          <label>
            Valor liquidativo de destino el día del traspaso
            <input
              aria-label="Valor liquidativo de destino"
              defaultValue={initial.destinationPricePerUnit}
              inputMode="decimal"
              name="destinationPricePerUnit"
              onInput={() => {
                destinationPriceTouched.current = true;
              }}
              placeholder="14,50"
              ref={destinationPriceField}
            />
          </label>

          {/* The prefills are the LAST known prices, and a traspaso is often recorded
              days later — dating one in the past and leaving today's VL in the field
              would write participaciones nobody bought. Said next to the fields, only
              when the date makes it true. */}
          {values.executedAt && values.executedAt !== today ? (
            <p className="opCaptureHint">
              El traspaso no es de hoy: los valores liquidativos que hemos prefijado son
              los últimos conocidos, no los de esa fecha. Revísalos con el extracto.
            </p>
          ) : null}
        </div>

        {/* The two halves of a real traspaso do NOT match: the origin is valued the
            day the capital leaves and the destination the day it lands (measured:
            739,22 € out, 740,72 € in). Folded away because it is the exception, and
            blank means «the same». */}
        <details suppressHydrationWarning className="transferArrival">
          <summary>El importe que llegó fue distinto</summary>
          <label>
            Importe que llegó al destino ({origin.currency})
            <input
              aria-label={`Importe que llegó al destino en ${origin.currency}`}
              defaultValue={initial.destinationAmount}
              inputMode="decimal"
              name="destinationAmount"
              placeholder="740,72"
            />
          </label>
        </details>

        <TransferPreviewLine
          currency={origin.currency}
          date={values.executedAt || today}
          preview={preview}
          privacyMode={privacyMode}
          reading={transferReading(values)}
        />

        <RecordTransferSubmit disabled={readOnly} pending={isRecording} />
      </form>
    </section>
  );
}

/**
 * The line under the fields: the pair as it would be written, or the refusal that
 * says why it would not be. Both are announced (`aria-live`), because the figures
 * change while the user types and a screen reader would otherwise never hear them.
 */
function TransferPreviewLine({
  currency,
  date,
  preview,
  privacyMode,
  reading,
}: {
  /** The currency both ledgers keep — the pair is refused across two (ADR 0083). */
  currency: CurrencyCode;
  date: string;
  preview: ReturnType<typeof previewTransfer>;
  privacyMode: boolean;
  /** Which figures are being typed — so the silence names the ones still missing. */
  reading: TransferReading;
}) {
  if (preview.status === "incomplete") {
    return (
      <p aria-live="polite" className="opCaptureHint">
        {reading === "units"
          ? "Indica el destino, el importe y las participaciones de cada lado y te diré a qué valor liquidativo queda cada apunte."
          : "Indica el destino, el importe y los dos valores liquidativos y te diré cuántas participaciones se mueven."}
      </p>
    );
  }

  if (preview.status === "refused") {
    return (
      <p aria-live="polite" className="errorBand">
        {preview.message}
      </p>
    );
  }

  const money = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);

  return (
    <p aria-live="polite" className="opCaptureHint">
      El {formatIsoDayEs(date)} saldrán {formatUnits(preview.outUnits)} participaciones (
      {money(preview.outgoingAmountMinor)}) y entrarán {formatUnits(preview.inUnits)} (
      {money(preview.incomingAmountMinor)}). Viaja con ellas un coste de adquisición de{" "}
      {money(preview.inheritedCostMinor)}, así que no se realiza plusvalía.{" "}
      {/* The derived figure, printed in both readings (#1544): the VL when the
          participaciones were declared, and the echo of what was typed when they were
          not. Either way it is what the two apuntes will hold, so the paper in hand can
          be checked against it. */}
      Cada apunte queda a un valor liquidativo de {formatPrice(preview.outPricePerUnit)}{" "}
      {currency} (origen) y {formatPrice(preview.inPricePerUnit)} {currency} (destino).
    </p>
  );
}
