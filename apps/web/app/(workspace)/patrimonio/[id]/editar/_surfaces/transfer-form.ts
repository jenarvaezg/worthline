import { mapDomainViolation, type StrictParseResult } from "@web/intake";
import { parseOptionalSecurityId } from "@web/intake/investment";
import {
  normalizeNonNegativeDecimalString,
  parseMoneyMinor,
} from "@web/intake-primitives";
import type {
  CurrencyCode,
  DecimalString,
  Instrument,
  InvestmentOperation,
  ManualAsset,
  SecurityId,
  SecurityIdKind,
  TransferPortion,
} from "@worthline/domain";
import {
  derivePosition,
  keepsAnOperationLedger,
  operationsUpTo,
  planTransfer,
  securityIdFieldForInstrument,
} from "@worthline/domain";

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
 * client-side lookalike, and folds the origin's ledger at the transfer date the way
 * the gate folds it.
 *
 * Prior art in this folder: `cobros-form.ts`, the same shape of shared pure module
 * behind a section and its action.
 *
 * Since #1544 the form has TWO readings ({@link TransferReading}), because a
 * justificante states four figures — participaciones and importe per leg — and the VL
 * is not one of them. The mode decides which two figures each leg is read from; the
 * third is derived by the plan, and the preview prints it so the derivation stays
 * checkable against the paper.
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
  "newDestinationSecurityId",
  "executedAt",
  "portion",
  "amount",
  "reading",
  "originUnits",
  "destinationUnits",
  "originPricePerUnit",
  "destinationPricePerUnit",
  "destinationAmount",
] as const;

/**
 * Which two figures per leg the user is copying (#1544).
 *
 * - `units` — the participaciones and the importe, the four figures a justificante
 *   prints. The VL of each leg is DERIVED, so nobody has to look one up, and the
 *   participaciones stored are the bank's own rather than a division's.
 * - `price` — the importe and the VL, the reading the form was born with (#1480). Kept
 *   because it is the honest one when the paper in hand states no participaciones.
 *
 * It is a MODE and not a guess at what happens to be filled in: the fields of the other
 * reading are still posted (they are hidden with CSS, exactly as the destination pane
 * is), so sniffing them would let a stale VL from three edits ago decide the write.
 */
export type TransferReading = "units" | "price";

/** The traspaso form's fields, exactly as typed — trimmed, nothing else. */
export interface TransferFormValues {
  /** An existing holding's id, or {@link NEW_DESTINATION}. */
  destinationAssetId: string;
  newDestinationName: string;
  /**
   * The identifier a destination created by this submit is born with, in whatever
   * class its inherited instrument admits (#1772) — an ISIN for a fund, a plan's DGS
   * code for a plan. Raw as typed: only {@link parseNewDestinationSecurityId}, which
   * knows the instrument, may turn it into a typed pair.
   */
  newDestinationSecurityId: string;
  executedAt: string;
  /** `"all"` for «todo»; anything else reads as an importe. */
  portion: string;
  amount: string;
  /** `"units"` or `"price"` — see {@link TransferReading}. Blank falls back to inference. */
  reading: string;
  /** Participaciones that left, as the justificante prints them (`units` reading). */
  originUnits: string;
  /** Participaciones that arrived, likewise. */
  destinationUnits: string;
  originPricePerUnit: string;
  destinationPricePerUnit: string;
  /** The importe that ARRIVED, when the bank states a different one. Blank = same. */
  destinationAmount: string;
}

/**
 * Where the participaciones land: a holding this book already has, or a new one.
 *
 * A new destination carries only its NAME. Its identifier is not here because it is
 * not the form's to classify: which class the box asks for is decided by the
 * instrument the destination inherits from the origin, and the origin lives in the
 * store (#1772) — see {@link parseNewDestinationSecurityId}.
 */
export type TransferDestination =
  | { kind: "existing"; assetId: string }
  | { kind: "new"; name: string };

/**
 * One traspaso as the form states it — everything but the ids and the origin, which
 * the action mints and reads.
 */
export interface TransferDraft {
  destination: TransferDestination;
  executedAt: string;
  portion: TransferPortion;
  /** Present only in the `price` reading; derived from the figures otherwise (#1544). */
  originPricePerUnit?: DecimalString | undefined;
  destinationPricePerUnit?: DecimalString | undefined;
  /** Present only in the `units` reading. */
  destinationUnits?: DecimalString | undefined;
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

/**
 * The origin, as a preview needs it: its LEDGER, not a folded position.
 *
 * The fold has to happen at the traspaso's date, and the date is a field the user
 * changes — a position folded once, up front, would be today's. That is precisely the
 * disagreement between preview and writer that #1438 measured, so the ledger travels
 * and {@link previewTransfer} folds it the way the gate does (`operationsUpTo`).
 */
export interface TransferPreviewOrigin {
  assetId: string;
  currency: CurrencyCode;
  operations: readonly InvestmentOperation[];
}

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
      /** Participaciones leaving the origin — as declared, or divided and cut at six decimals. */
      outUnits: DecimalString;
      /** Participaciones arriving at the destination, likewise. */
      inUnits: DecimalString;
      outgoingAmountMinor: number;
      incomingAmountMinor: number;
      /** The acquisition cost travelling with the units. */
      inheritedCostMinor: number;
      /**
       * The VL each half will be written at (#1544). In the `units` reading these are
       * the DERIVED figures, and printing them is what makes the derivation checkable
       * against the paper in hand; in the `price` reading they echo what was typed.
       */
      outPricePerUnit: DecimalString;
      inPricePerUnit: DecimalString;
    };

/** Read the form's fields off a `FormData`, trimmed. A missing field is blank. */
export function readTransferFormValues(formData: FormData): TransferFormValues {
  const read = (field: string) => String(formData.get(field) ?? "").trim();

  return {
    amount: read("amount"),
    destinationAmount: read("destinationAmount"),
    destinationAssetId: read("destinationAssetId"),
    destinationPricePerUnit: read("destinationPricePerUnit"),
    destinationUnits: read("destinationUnits"),
    executedAt: read("executedAt"),
    newDestinationSecurityId: read("newDestinationSecurityId"),
    newDestinationName: read("newDestinationName"),
    originPricePerUnit: read("originPricePerUnit"),
    originUnits: read("originUnits"),
    portion: read("portion"),
    reading: read("reading"),
  };
}

/**
 * The reading these fields are stated in.
 *
 * The posted mode is authoritative. Absent — a hand-built `FormData`, or a client that
 * predates #1544 — it is inferred from whether any participaciones were stated, which
 * makes every older caller keep working unchanged.
 */
export function transferReading(values: TransferFormValues): TransferReading {
  if (values.reading === "units" || values.reading === "price") return values.reading;
  return values.originUnits || values.destinationUnits ? "units" : "price";
}

/**
 * Parse the form into a draft, or the ONE message that names the field to fix.
 *
 * The refusals about the FIGURES (an importe over the position, a VL of zero, the
 * same holding twice) are not here: they belong to `planTransfer`, which both this
 * module's preview and the gate run. What is here is what a plan cannot see — a
 * field left blank, a destination not chosen, a name missing on a destination that
 * has to be created first.
 *
 * Nor is the new destination's IDENTIFIER here (#1772): the class it must validate
 * as comes from the instrument the destination inherits, which only the store knows.
 * {@link parseNewDestinationSecurityId} is that boundary.
 */
export function parseTransferForm(
  values: TransferFormValues,
  today: string,
): StrictParseResult<TransferDraft> {
  const destination = parseDestination(values);
  if (!destination.ok) return destination;

  const reading = transferReading(values);

  const portion = parsePortion(values, reading);
  if (!portion.ok) return portion;

  // Each reading states exactly two figures per leg, and the third is derived by
  // `planTransfer` (#1544). The fields of the OTHER reading are still posted — they are
  // hidden with CSS, not removed — so they are not even read here: a VL left over from
  // an earlier edit must never reach a write the user is stating in participaciones.
  const legs =
    reading === "units" ? statedDestinationUnits(values) : statedPrices(values);
  if (!legs.ok) return legs;

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
      executedAt: values.executedAt || today,
      portion: portion.portion,
      ...legs.legs,
      ...(destinationAmountMinor === undefined ? {} : { destinationAmountMinor }),
    },
  };
}

/** The two figures the `price` reading states per leg: each leg's VL. */
function statedPrices(values: TransferFormValues):
  | {
      ok: true;
      legs: Pick<TransferDraft, "originPricePerUnit" | "destinationPricePerUnit">;
    }
  | { ok: false; error: string } {
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

  return {
    legs: {
      destinationPricePerUnit: destinationPricePerUnit as DecimalString,
      originPricePerUnit: originPricePerUnit as DecimalString,
    },
    ok: true,
  };
}

/**
 * The `units` reading's own second figure: the participaciones that ARRIVED. Named for
 * the one leg it reads, because the ORIGIN's ride in the portion, next to the importe
 * they came with — «todo» states them by naming the position instead of typing a count.
 */
function statedDestinationUnits(
  values: TransferFormValues,
):
  | { ok: true; legs: Pick<TransferDraft, "destinationUnits"> }
  | { ok: false; error: string } {
  const destinationUnits = statedUnitsField(values.destinationUnits, "destination");
  if (!destinationUnits.ok) return destinationUnits;

  return { legs: { destinationUnits: destinationUnits.units }, ok: true };
}

/**
 * One participaciones field, read the way a price field is: normalized through the
 * decimal seam, and refused by its own code so the message points at the field the user
 * was actually asked to fill (#1544). Shared by both legs — the origin's lives in
 * {@link parsePortion} — so a blank count reads the same on either side.
 */
function statedUnitsField(
  raw: string,
  side: "origin" | "destination",
): { ok: true; units: DecimalString } | { ok: false; error: string } {
  const units = normalizeNonNegativeDecimalString(raw);
  if (units === null || units === "0") {
    return {
      ok: false,
      error: mapDomainViolation({ code: "transfer_units_not_positive", side }),
    };
  }
  return { ok: true, units: units as DecimalString };
}

/**
 * The pair the gate would write from these fields, printed as the user types.
 *
 * Runs the real plan against the origin's position AS OF THE TRANSFER DATE, folded
 * here with `operationsUpTo` exactly as the gate folds it — so the participaciones on
 * screen are the participaciones that get stored, including the cut at
 * `UNITS_READBACK_DECIMALS` (#1395), the exact-liquidation shape of «todo», and the
 * refusal of an importe the position cannot cover. Folding today's position instead
 * would make a backdated traspaso preview one figure and store another.
 *
 * The same function answers on the server (`recordTransferAction`), which is why the
 * refusal it returns is a message and not a guess.
 */
export function previewTransfer(
  values: TransferFormValues,
  origin: TransferPreviewOrigin,
  today: string,
): TransferPreview {
  const parsed = parseTransferForm(values, today);
  if (!parsed.ok) return { status: "incomplete" };

  const position = derivePosition(
    operationsUpTo(origin.operations, parsed.command.executedAt.slice(0, 10)),
    { assetId: origin.assetId, currency: origin.currency },
  );

  const plan = planTransfer(
    {
      currency: origin.currency,
      destinationAssetId:
        parsed.command.destination.kind === "existing"
          ? parsed.command.destination.assetId
          : NEW_DESTINATION_PREVIEW_ID,
      destinationPricePerUnit: parsed.command.destinationPricePerUnit,
      destinationUnits: parsed.command.destinationUnits,
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
    {
      costBasisMinor: position.costBasis.amountMinor,
      unitsHeld: position.currentUnits,
    },
  );

  if (!plan.ok) {
    return { message: mapDomainViolation(plan.violations[0]), status: "refused" };
  }

  return {
    inPricePerUnit: plan.value.incoming.pricePerUnit,
    inUnits: plan.value.incoming.units,
    incomingAmountMinor: plan.value.incomingAmountMinor,
    inheritedCostMinor: plan.value.inheritedCostMinor,
    outPricePerUnit: plan.value.out.pricePerUnit,
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

  return { destination: { kind: "new", name }, ok: true };
}

/** The origin, as the destination's identity reads it: the instrument it inherits. */
export interface TransferOriginInstrument {
  instrument?: Instrument | undefined;
}

/**
 * The instrument a destination created by this traspaso is born with: the origin's,
 * because the capital only moved (`resolveDestination`). `fund` when the origin
 * carries none, which is the class the field asked for before #1772.
 *
 * It lives here, exported, so the screen's label and the write's validation read ONE
 * derivation. Two would let the box say «Código DGS del plan» while the rule behind
 * it still accepted an ISIN — the very disagreement #1489 was.
 */
export function transferDestinationInstrument(
  origin: TransferOriginInstrument,
): Instrument {
  return origin.instrument ?? "fund";
}

/**
 * The identifier field the «crear destino» pane renders, or null when the inherited
 * instrument has no identifier at all (crypto) — the same domain map the alta, the
 * ficha and the health signal read, so the question and the warning cannot disagree.
 */
export function newDestinationSecurityIdField(
  origin: TransferOriginInstrument,
): { kind: SecurityIdKind; label: string } | null {
  return securityIdFieldForInstrument(transferDestinationInstrument(origin));
}

/**
 * The typed identifier a created destination is BORN with (#1772), validated against
 * the instrument it inherits instead of against the ISIN this field used to assume.
 *
 * The bug it closes: traspasar a plan to a plan asked for «ISIN del destino» — an
 * identifier that product cannot have (#1489 again) — and anything that passed the
 * check digit was written as `kind: 'isin'`, the fourth state #1746 declared
 * impossible in every interactive write (invariante 3 del PRD #1741). The ficha could
 * SEE it afterwards; nothing stopped it being born.
 *
 * Why it is not part of {@link parseTransferForm}: the class comes from the origin's
 * instrument, and only the store knows it — a posted instrument would put the
 * invariant in the client's hands. So the pair is built on the server, beside the row
 * it will be written on, and a refusal still lands on the form as a message because
 * nothing has been created at that point.
 *
 * Blank stays blank: the identifier is optional (invariante 6 del PRD #1741), and a
 * partícipe without the paper in hand is a legitimate state.
 */
export function parseNewDestinationSecurityId({
  destination,
  origin,
  values,
}: {
  destination: TransferDestination;
  origin: TransferOriginInstrument;
  values: TransferFormValues;
}): { ok: true; securityId?: SecurityId } | { ok: false; error: string } {
  // The «crear destino» pane is hidden with CSS, not removed, so its box is still
  // posted when the user went on to pick an existing holding. Reading it there would
  // refuse a perfectly good traspaso over a value nobody meant to submit — the same
  // trap the two readings avoid by never sniffing the other one's fields.
  if (destination.kind !== "new") return { ok: true };

  const field = newDestinationSecurityIdField(origin);
  if (!field) return { ok: true };

  return parseOptionalSecurityId(field.kind, values.newDestinationSecurityId);
}

/**
 * How much of the origin leaves, in the reading the form is in.
 *
 * «Todo» stays its own intent in both: only it liquidates the origin exactly. What
 * changes is what it needs beside it — nothing in the `price` reading (the importe is
 * derived at the VL, so the field is not even read), and the justificante's importe in
 * the `units` reading, which is what derives the VL of the whole position.
 */
function parsePortion(
  values: TransferFormValues,
  reading: TransferReading,
): { ok: true; portion: TransferPortion } | { ok: false; error: string } {
  if (values.portion === "all" && reading === "price") {
    return { ok: true, portion: { kind: "all" } };
  }

  const amountMinor = parseMoneyMinor(values.amount);
  if (amountMinor === null || amountMinor <= 0) {
    // «Todo» in the participaciones reading is the ONE case where the importe became
    // obligatory where it was not before, so the refusal says what it is for instead of
    // repeating «indícalo en euros» at someone who thought they had finished.
    return {
      ok: false,
      error:
        values.portion === "all"
          ? "Con «todo» necesito el importe del justificante: de él sale el valor liquidativo de la posición entera. Indícalo en euros (p. ej. 1.018,67)."
          : "El importe traspasado no es válido — indícalo en euros (p. ej. 739,22).",
    };
  }

  if (values.portion === "all") {
    return { ok: true, portion: { amountMinor, kind: "all" } };
  }

  if (reading === "price") {
    return { ok: true, portion: { amountMinor, kind: "amount" } };
  }

  const units = statedUnitsField(values.originUnits, "origin");
  if (!units.ok) return units;

  return { ok: true, portion: { amountMinor, kind: "units", units: units.units } };
}

/** The mutable holder of the in-flight submission key — a ref in the island. */
export interface SubmissionKeyRef {
  current: string | null;
}

/**
 * Stamp the idempotency key onto a submit and publish it as the in-flight one
 * (#1394), returning it.
 *
 * The two writes — onto the body and onto the ref — are the whole guard, so they live
 * in one tested function rather than inline in the island: the window a double click
 * exploits is the frame BEFORE any pending flag flips, which is why publishing is
 * synchronous. A submit that arrives while one is in flight reuses its key, so the
 * server recognises the replay instead of writing a second pair. Sibling: the
 * operations editor's `submitOperationRecord`, which also carries an optimistic row.
 */
export function stampTransferSubmission(
  formData: FormData,
  keyRef: SubmissionKeyRef,
  newId: () => string,
): string {
  const key = keyRef.current ?? newId();
  keyRef.current = key;
  formData.set("submissionId", key);
  return key;
}
