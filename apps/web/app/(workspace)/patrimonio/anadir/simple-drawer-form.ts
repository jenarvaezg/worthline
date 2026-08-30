/**
 * The simple wizard's drawers, translated into an instrument (#596/#597, #1611).
 *
 * The add flow has two surfaces. The avanzado form posts the instrument itself,
 * with that instrument's fields suffixed (`name_fund`, `balance_mortgage`…). The
 * simple wizard posts a DRAWER — «dinero», «inmueble», «bien», «deuda»,
 * «inversión» — with drawer-scoped fields, and the instrument is a consequence of
 * what was ticked inside it (a plazo fijo is «dinero» + «a plazo»; a piso is
 * «inmueble»).
 *
 * This module is the one place that translation happens, and it runs BEFORE the
 * alta knows which family it is dealing with. Everything downstream — the family
 * routing, every command — reads one shape: `<field>_<instrument>`.
 *
 * It rewrites and never validates: an unreadable drawer comes back with a null
 * instrument and, where the wizard can say something useful, a message. The
 * families own the validation.
 */

import { CURRENT_STATE_DEBT_FIELD_NAMES } from "@web/patrimonio/current-state-debt";
import type { Instrument } from "@worthline/domain";

/** The simple wizard's five drawers. */
export type SimpleDrawer = "bien" | "deuda" | "dinero" | "inmueble" | "inversion";

const SIMPLE_DRAWERS: readonly string[] = [
  "dinero",
  "inmueble",
  "bien",
  "deuda",
  "inversion",
];

/**
 * The instruments the add form offers. `coin_collection` is deliberately absent:
 * a Numista collection is created by connecting the source, not by hand (ADR
 * 0016).
 */
const INSTRUMENTS: readonly Instrument[] = [
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

export function parseInstrument(value: FormDataEntryValue | null): Instrument | null {
  const raw = String(value ?? "").trim();
  return (INSTRUMENTS as readonly string[]).includes(raw) ? (raw as Instrument) : null;
}

function parseSimpleDrawer(value: FormDataEntryValue | null): SimpleDrawer | null {
  const raw = String(value ?? "").trim();
  return SIMPLE_DRAWERS.includes(raw) ? (raw as SimpleDrawer) : null;
}

/**
 * The wizard's own fields, refilled after a rejected alta. They are NOT suffixed
 * by instrument — the drawer is the same whichever instrument it resolves to —
 * so they are preserved as they are, alongside the chosen family's own list.
 */
export const SIMPLE_FIELD_KEYS: readonly string[] = [
  "returnTo",
  "simpleDrawer",
  "simpleName",
  "simpleValue",
  "simpleName_dinero",
  "simpleValue_dinero",
  "cashTerm_dinero",
  "simpleName_inmueble",
  "simpleValue_inmueble",
  "primaryResidence_inmueble",
  "simpleName_bien",
  "simpleValue_bien",
  "simpleName_deuda",
  "simpleValue_deuda",
  "simpleAssetKind",
  "simpleDebtKind",
  // «Alta por estado actual» (ADR 0056, #677) — the debt drawer's default path.
  ...CURRENT_STATE_DEBT_FIELD_NAMES,
];

function copyFormData(formData: FormData): FormData {
  const copy = new FormData();
  for (const [key, value] of formData.entries()) {
    copy.append(key, value);
  }
  return copy;
}

/** The drawer, rewritten as the instrument's own suffixed fields. */
export interface NormalizedAltaForm {
  formData: FormData;
  instrument: Instrument | null;
  /** What to tell the user when the drawer resolved to no instrument at all. */
  unsupported?: string;
}

export function normalizeSimpleDrawerForm(
  formData: FormData,
  today: string,
): NormalizedAltaForm {
  const drawer = parseSimpleDrawer(formData.get("simpleDrawer"));

  if (!drawer) {
    return { formData, instrument: parseInstrument(formData.get("instrument")) };
  }

  if (drawer === "inversion") {
    // The 3 behavior groups (#597): «Cotiza en bolsa»→fund, «Plan de pensiones»→
    // pension_plan, «Cripto»→crypto. The group radio posts the instrument
    // directly, and the pane already posts instrument-suffixed fields (name_/
    // symbol_/price_/saldo_/invMode_), so the family reads them with no remap.
    const instrument = parseInstrument(formData.get("instrument"));
    if (
      instrument !== "fund" &&
      instrument !== "pension_plan" &&
      instrument !== "crypto"
    ) {
      return {
        formData,
        instrument: null,
        unsupported: "Elige dónde está tu inversión: bolsa, plan de pensiones o cripto.",
      };
    }
    return { formData, instrument };
  }

  const normalized = copyFormData(formData);
  const simpleValueFor = (key: string): string =>
    String(formData.get(`${key}_${drawer}`) ?? formData.get(key) ?? "");
  const simpleName = simpleValueFor("simpleName");
  const simpleValue = simpleValueFor("simpleValue");
  const instrument =
    drawer === "dinero"
      ? formData.get("cashTerm_dinero") === "on" || formData.get("cashTerm") === "on"
        ? "term_deposit"
        : "current_account"
      : drawer === "inmueble"
        ? "property"
        : drawer === "bien"
          ? (parseInstrument(formData.get("simpleAssetKind")) ?? "other")
          : parseInstrument(formData.get("simpleDebtKind"));

  if (!instrument) {
    return { formData: normalized, instrument: null };
  }

  normalized.set("instrument", instrument);
  normalized.set(`name_${instrument}`, simpleName);

  if (drawer === "deuda") {
    normalized.set(`balance_${instrument}`, simpleValue);
  } else if (drawer === "inmueble") {
    // The drawer never asks WHEN it was bought — it stamps today, which is the
    // contradiction the housing family goes on to ask about (#1561).
    normalized.set("acqDate_property", today);
    normalized.set("acqValue_property", simpleValue);
    if (
      formData.get("primaryResidence_inmueble") === "on" ||
      formData.get("primaryResidence") === "on"
    ) {
      normalized.set("isPrimaryResidence_property", "on");
    }
  } else {
    normalized.set(`value_${instrument}`, simpleValue);
  }

  return { formData: normalized, instrument };
}
