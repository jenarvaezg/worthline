import type { Instrument } from "@worthline/domain";
import { securityIdFieldForInstrument } from "@worthline/domain";

export type AddHoldingSearchParams = Record<string, string | string[] | undefined>;

const ADD_HOLDING_INSTRUMENTS: readonly Instrument[] = [
  "current_account",
  "term_deposit",
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
  "crypto",
  "precious_metal",
  "vehicle",
  "property",
  "other",
  "mortgage",
  "loan",
  "credit_card",
];

const ADD_HOLDING_FIELD_KEYS = [
  "name",
  "value",
  "symbol",
  // The instrument's own identifier (#1746): «securityId» whatever the kind, so the
  // key that survives a pick navigation does not have to name the ISIN half of it.
  "securityId",
  "price",
  "acqDate",
  "acqValue",
  // The property's acquisition cost (#1441) — off the escritura, so it survives a
  // symbol-pick navigation like the investment capture figures below.
  "acqCost",
  "rate",
  "balance",
  "assoc",
  "inheritOwnership",
  // The simple investment drawer's capture fields (#597): preserved across a
  // symbol-pick navigation so a typed saldo / chosen mode survives re-picking. Since
  // #1490 that includes the acquisition cost, its mode and the date the position is
  // held since — the three figures the user had to go and look up.
  "saldo",
  "saldoDate",
  "cost",
  "costMode",
  "invMode",
];

// `simpleDrawer` rides along so the chosen drawer (and thus the revealed pane)
// survives a symbol pick, which navigates via a built link rather than a full
// form submit (#597).
const SHARED_ADD_FORM_KEYS = new Set([
  "ownershipPreset",
  "scopeMemberId",
  "simpleDrawer",
]);

function paramValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function firstNonEmptyParam(
  value: string | string[] | undefined,
): string | undefined {
  const values = paramValues(value);

  return values.find((item) => item.trim() !== "") ?? values[0];
}

function parseInstrumentParam(
  value: string | string[] | undefined,
): Instrument | undefined {
  const raw = firstNonEmptyParam(value)?.trim();

  return ADD_HOLDING_INSTRUMENTS.includes(raw as Instrument)
    ? (raw as Instrument)
    : undefined;
}

export function selectedInstrumentFromAddHoldingState(
  values: Record<string, string>,
  searchParams: AddHoldingSearchParams,
): Instrument | undefined {
  return parseInstrumentParam(values["instrument"] ?? searchParams["instrument"]);
}

export function addHoldingFieldValue({
  field,
  instrument,
  searchParams,
  selectedInstrument,
  values,
}: {
  field: string;
  instrument: Instrument;
  searchParams: AddHoldingSearchParams;
  selectedInstrument: Instrument | undefined;
  values: Record<string, string>;
}): string | undefined {
  const savedValue = values[`${field}_${instrument}`];

  if (instrument !== selectedInstrument) {
    return savedValue;
  }

  if (field === "name") {
    const pickedName = firstNonEmptyParam(searchParams["pfName"]);
    if (pickedName) return pickedName;
  }

  if (field === "symbol") {
    const pickedSymbol = firstNonEmptyParam(searchParams["pfSymbol"]);
    if (pickedSymbol) return pickedSymbol;
  }

  // A candidate's ISIN prefills the identifier field ONLY where the instrument's
  // identifier IS an ISIN (#1746). A pension plan is identified by its DGS code, and
  // the code the user typed is what the alta must store: a Finect hit that happened
  // to carry an ISIN must never overwrite it.
  if (
    field === "securityId" &&
    securityIdFieldForInstrument(instrument)?.kind === "isin"
  ) {
    const pickedIsin = firstNonEmptyParam(searchParams["pfIsin"]);
    if (pickedIsin) return pickedIsin;
  }

  return savedValue ?? firstNonEmptyParam(searchParams[`${field}_${instrument}`]);
}

function nonEmptyParamValue(
  value: string | string[] | undefined,
): string | string[] | undefined {
  const values = paramValues(value).filter((item) => item.trim() !== "");
  if (values.length === 0) return undefined;

  return values.length === 1 ? values[0] : values;
}

function isSelectedInstrumentField(
  key: string,
  instrument: Instrument | undefined,
): boolean {
  return instrument
    ? ADD_HOLDING_FIELD_KEYS.some((field) => key === `${field}_${instrument}`)
    : false;
}

export function buildSymbolSearchCurrentParams(
  searchParams: AddHoldingSearchParams,
  selectedInstrument?: Instrument | undefined,
): AddHoldingSearchParams {
  const instrument =
    selectedInstrument ?? parseInstrumentParam(searchParams["instrument"]);
  const params: AddHoldingSearchParams = {};

  if (instrument) {
    params.instrument = instrument;
  }

  for (const [key, value] of Object.entries(searchParams)) {
    if (
      key === "instrument" ||
      key === "symbolq" ||
      key === "pfName" ||
      key === "pfSymbol" ||
      key === "pfIsin" ||
      key === "pfProvider" ||
      key.startsWith("$ACTION_")
    ) {
      continue;
    }

    if (
      !SHARED_ADD_FORM_KEYS.has(key) &&
      !key.startsWith("owner_") &&
      !isSelectedInstrumentField(key, instrument)
    ) {
      continue;
    }

    const nonEmptyValue = nonEmptyParamValue(value);
    if (nonEmptyValue !== undefined) {
      params[key] = nonEmptyValue;
    }
  }

  return params;
}
