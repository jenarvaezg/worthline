import { mapDomainViolation, type StrictParseResult } from "@web/intake";
import { parseOptionalIsin } from "@web/intake/investment";
import {
  normalizeNonNegativeDecimalString,
  parseMoneyMinor,
} from "@web/intake-primitives";
import type {
  DecimalString,
  ManualAsset,
  TransferOrigin,
  TransferPortion,
} from "@worthline/domain";
import { keepsAnOperationLedger, planTransfer } from "@worthline/domain";

/**
 * The traspaso form's pure seam (#1480, S3 of PRD #1393): the fields the screen
 * posts, the draft they parse into, and the pair they preview.
 *
 * Why the SAME module serves the island and the server action. The screen has to
 * print the participaciones that will leave and arrive as the user types, and the
 * action has to write them; two derivations of that would be two engines, which is
 * the mistake #1438 measured (a preview that disagreed with the writer left 266
 * wrong snapshots). So there is one parser, and the preview runs
 * {@link planTransfer} — the very function behind the write gate — rather than a
 * client-side lookalike. The only thing the preview cannot know is the currency the
 * two ledgers keep (the gate reads it, and refuses a mismatch); it plays no part in
 * the arithmetic, so the preview passes EUR and never shows it.
 *
 * Prior art in this folder: `cobros-form.ts`, the same shape of shared pure module
 * behind a section and its action.
 */

/**
 * The destination `<option>` that means «I do not have this holding yet». A
 * sentinel rather than an empty value, so «nothing chosen» and «create one» are
 * distinguishable — the first is an unfinished form, the second an intent.
 */
export const NEW_DESTINATION = "__new__";

/**
 * The stand-in id the preview gives a destination that does not exist yet. Only
 * `planTransfer`'s same-holding refusal ever compares it, and no stored id has this
 * shape, so it can never collide with the origin.
 */
const NEW_DESTINATION_PREVIEW_ID = "__new_destination_preview__";

/** The fields a rejected submit round-trips, so nothing typed is lost (#1329). */
export const TRANSFER_FORM_FIELDS = [
  "destinationAssetId",
  "newDestinationName",
  "newDestinationIsin",
  "executedAt",
  "portion",
  "amount",
  "originPricePerUnit",
  "destinationPricePerUnit",
  "destinationAmount",
] as const;

/** The traspaso form's fields, exactly as typed — trimmed, nothing else. */
export interface TransferFormValues {
  /** An existing holding's id, or {@link NEW_DESTINATION}. */
  destinationAssetId: string;
  newDestinationName: string;
  newDestinationIsin: string;
  executedAt: string;
  /** `"all"` for «todo»; anything else reads as an importe. */
  portion: string;
  amount: string;
  originPricePerUnit: string;
  destinationPricePerUnit: string;
  /** The importe that ARRIVED, when the bank states a different one. Blank = same. */
  destinationAmount: string;
}

/** Where the participaciones land: a holding this book already has, or a new one. */
export type TransferDestination =
  | { kind: "existing"; assetId: string }
  | { kind: "new"; name: string; isin?: string };

/**
 * One traspaso as the form states it — everything but the ids and the origin, which
 * the action mints and reads.
 */
export interface TransferDraft {
  destination: TransferDestination;
  executedAt: string;
  portion: TransferPortion;
  originPricePerUnit: DecimalString;
  destinationPricePerUnit: DecimalString;
  destinationAmountMinor?: number;
}

/** A holding this workspace already has, offered as a destination. */
export interface TransferDestinationOption {
  assetId: string;
  name: string;
  /** Its last known unit price, when there is one — the VL field's prefill. */
  pricePerUnit?: string;
}

/**
 * The holdings this one can be traspasado to, in reading order.
 *
 * What it excludes, and why each one would otherwise be a dead end on screen:
 *
 * - **The origin itself** — the gate refuses it, and offering it is a trap.
 * - **Anything that does not keep an operation ledger** (`keepsAnOperationLedger`,
 *   the same seam the contribution allowance reads): a stored-value holding has no
 *   participaciones to receive, and a connected-source one would have its position
 *   re-rolled by the next sync, so the gate THROWS on it — a broken screen, not a
 *   message.
 * - **A coin collection**, belt to that brace: it is `derived` from positions rather
 *   than operations, and the gate refuses a non-investment holding by throwing.
 * - **Another currency**: the cost that travels would need a rate nobody stated.
 *   The gate says this one with a message, but a picker that only offers what can
 *   work is better than one that explains afterwards.
 *
 * The prefill price comes from the positions already read for the page — one figure
 * per holding, no extra query per candidate. A holding with no position yet simply
 * has none, and the user types the VL.
 */
export function transferDestinationOptions(
  assets: readonly ManualAsset[],
  positions: ReadonlyArray<{ assetId: string; currentPricePerUnit?: DecimalString }>,
  origin: { assetId: string; currency: string },
): TransferDestinationOption[] {
  const priceOf = new Map(
    positions.map((position) => [position.assetId, position.currentPricePerUnit]),
  );

  return assets
    .filter(
      (asset) =>
        asset.id !== origin.assetId &&
        asset.currency === origin.currency &&
        asset.instrument !== "coin_collection" &&
        keepsAnOperationLedger(asset),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "es-ES"))
    .map((asset) => {
      const pricePerUnit = priceOf.get(asset.id);
      return {
        assetId: asset.id,
        name: asset.name,
        ...(pricePerUnit ? { pricePerUnit } : {}),
      };
    });
}

/** The origin's folded position, plus the id the same-holding check compares. */
export type TransferPreviewOrigin = TransferOrigin & { assetId: string };

/**
 * What the form prints under the fields: the pair, a refusal, or nothing at all.
 *
 * `incomplete` is deliberate silence. A form half typed is not a form with an error,
 * and shouting «indica el importe» at the first keystroke trains people to ignore
 * the band that will later carry the refusal that matters.
 */
export type TransferPreview =
  | { status: "incomplete" }
  | { status: "refused"; message: string }
  | {
      status: "ready";
      /** Participaciones leaving the origin, cut at the app's read-back precision. */
      outUnits: DecimalString;
      /** Participaciones arriving at the destination, at ITS own VL. */
      inUnits: DecimalString;
      outgoingAmountMinor: number;
      incomingAmountMinor: number;
      /** The acquisition cost travelling with the units. */
      inheritedCostMinor: number;
    };

/** Read the form's fields off a `FormData`, trimmed. A missing field is blank. */
export function readTransferFormValues(formData: FormData): TransferFormValues {
  const read = (field: string) => String(formData.get(field) ?? "").trim();

  return {
    amount: read("amount"),
    destinationAmount: read("destinationAmount"),
    destinationAssetId: read("destinationAssetId"),
    destinationPricePerUnit: read("destinationPricePerUnit"),
    executedAt: read("executedAt"),
    newDestinationIsin: read("newDestinationIsin"),
    newDestinationName: read("newDestinationName"),
    originPricePerUnit: read("originPricePerUnit"),
    portion: read("portion"),
  };
}

/**
 * Parse the form into a draft, or the ONE message that names the field to fix.
 *
 * The refusals about the FIGURES (an importe over the position, a VL of zero, the
 * same holding twice) are not here: they belong to `planTransfer`, which both this
 * module's preview and the gate run. What is here is what a plan cannot see — a
 * field left blank, a destination not chosen, a name missing on a destination that
 * has to be created first, an ISIN that fails its check digit (#1489).
 */
export function parseTransferForm(
  values: TransferFormValues,
  today: string,
): StrictParseResult<TransferDraft> {
  const destination = parseDestination(values);
  if (!destination.ok) return destination;

  const portion = parsePortion(values);
  if (!portion.ok) return portion;

  const originPricePerUnit = normalizeNonNegativeDecimalString(values.originPricePerUnit);
  if (originPricePerUnit === null || originPricePerUnit === "0") {
    return {
      ok: false,
      error: mapDomainViolation({ code: "transfer_price_not_positive", side: "origin" }),
    };
  }

  const destinationPricePerUnit = normalizeNonNegativeDecimalString(
    values.destinationPricePerUnit,
  );
  if (destinationPricePerUnit === null || destinationPricePerUnit === "0") {
    return {
      ok: false,
      error: mapDomainViolation({
        code: "transfer_price_not_positive",
        side: "destination",
      }),
    };
  }

  // The importe that arrived is optional and means «the same» when blank — the
  // ordinary case, and the only one the form asks about by default. Stated, it is a
  // second figure the bank printed, and the two genuinely differ (739,22 € out,
  // 740,72 € in, measured in Jorge's book): what ties the halves is the transferId.
  let destinationAmountMinor: number | undefined;
  if (values.destinationAmount) {
    const arrived = parseMoneyMinor(values.destinationAmount);
    if (arrived === null || arrived <= 0) {
      return { ok: false, error: "El importe que llegó al destino no es válido." };
    }
    destinationAmountMinor = arrived;
  }

  return {
    ok: true,
    command: {
      destination: destination.destination,
      destinationPricePerUnit: destinationPricePerUnit as DecimalString,
      executedAt: values.executedAt || today,
      originPricePerUnit: originPricePerUnit as DecimalString,
      portion: portion.portion,
      ...(destinationAmountMinor === undefined ? {} : { destinationAmountMinor }),
    },
  };
}

/**
 * The pair the gate would write from these fields, printed as the user types.
 *
 * Runs the real plan against the origin's folded position, so the participaciones on
 * screen are the participaciones that get stored — including the cut at
 * `UNITS_READBACK_DECIMALS` (#1395) and the exact-liquidation shape of «todo».
 */
export function previewTransfer(
  values: TransferFormValues,
  origin: TransferPreviewOrigin,
  today: string,
): TransferPreview {
  const parsed = parseTransferForm(values, today);
  if (!parsed.ok) return { status: "incomplete" };

  const plan = planTransfer(
    {
      currency: "EUR",
      destinationAssetId:
        parsed.command.destination.kind === "existing"
          ? parsed.command.destination.assetId
          : NEW_DESTINATION_PREVIEW_ID,
      destinationPricePerUnit: parsed.command.destinationPricePerUnit,
      executedAt: parsed.command.executedAt,
      inOperationId: "preview_in",
      originAssetId: origin.assetId,
      originPricePerUnit: parsed.command.originPricePerUnit,
      outOperationId: "preview_out",
      portion: parsed.command.portion,
      transferId: "preview",
      ...(parsed.command.destinationAmountMinor === undefined
        ? {}
        : { destinationAmountMinor: parsed.command.destinationAmountMinor }),
    },
    { costBasisMinor: origin.costBasisMinor, unitsHeld: origin.unitsHeld },
  );

  if (!plan.ok) {
    return { message: mapDomainViolation(plan.violations[0]), status: "refused" };
  }

  return {
    inUnits: plan.value.incoming.units,
    incomingAmountMinor: plan.value.incomingAmountMinor,
    inheritedCostMinor: plan.value.inheritedCostMinor,
    outUnits: plan.value.out.units,
    outgoingAmountMinor: plan.value.outgoingAmountMinor,
    status: "ready",
  };
}

function parseDestination(
  values: TransferFormValues,
): { ok: true; destination: TransferDestination } | { ok: false; error: string } {
  if (!values.destinationAssetId) {
    return { ok: false, error: "Elige la inversión de destino del traspaso." };
  }

  if (values.destinationAssetId !== NEW_DESTINATION) {
    return {
      destination: { assetId: values.destinationAssetId, kind: "existing" },
      ok: true,
    };
  }

  const name = values.newDestinationName.trim();
  if (!name) {
    return { ok: false, error: "El nombre de la inversión de destino es obligatorio." };
  }

  const isin = parseOptionalIsin(values.newDestinationIsin);
  if (!isin.ok) return isin;

  return {
    destination: { kind: "new", name, ...(isin.isin ? { isin: isin.isin } : {}) },
    ok: true,
  };
}

function parsePortion(
  values: TransferFormValues,
): { ok: true; portion: TransferPortion } | { ok: false; error: string } {
  // «Todo» is its own intent, not an importe that happens to equal the position:
  // only it liquidates the origin exactly, so the importe field is not even read.
  if (values.portion === "all") {
    return { ok: true, portion: { kind: "all" } };
  }

  const amountMinor = parseMoneyMinor(values.amount);
  if (amountMinor === null || amountMinor <= 0) {
    return {
      ok: false,
      error: "El importe traspasado no es válido — indícalo en euros (p. ej. 739,22).",
    };
  }

  return { ok: true, portion: { amountMinor, kind: "amount" } };
}
