import type { Instrument } from "@worthline/domain";

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
  "price",
  "acqDate",
  "acqValue",
  "rate",
  "balance",
  "assoc",
  "inheritOwnership",
];

const SHARED_ADD_FORM_KEYS = new Set(["ownershipPreset", "scopeMemberId"]);

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
