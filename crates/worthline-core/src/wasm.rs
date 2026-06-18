//! WASM binding (Module B, PRD #280 / issue #290) — compiled ONLY for wasm32.
//!
//! Exposes the amortization engine to JS with the SAME names `amortization.ts`
//! exports today. The JS↔WASM boundary is **coarse-grained**: a whole call's
//! inputs cross once as a JSON string carrying **decimal strings and integers
//! only** (no floats), one call computes a whole schedule internally, and the
//! result comes back as an integer (balance) or a small JSON object (the first
//! cuota's four integer fields). This is what keeps parity asserted on integers,
//! not on per-operation marshalling.
//!
//! Built with `--target nodejs`, `require()` instantiates the module's WASM once
//! and synchronously, so every exported function is synchronous thereafter — the
//! contract the synchronous domain (interleaved with synchronous DB reads and
//! ripple recalculation) depends on.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::{
    add_months, amortizable_balance_at_date, assert_event_within_term, first_cuota,
    suggest_first_payment_date, AmortizationPlan, BalanceAtDateInput, EarlyRepayment,
    EarlyRepaymentMode, InterestRateRevision,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanJson {
    initial_capital_minor: i64,
    annual_interest_rate: String,
    term_months: u32,
    disbursement_date: String,
    first_payment_date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionJson {
    revision_date: String,
    new_annual_interest_rate: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepaymentJson {
    repayment_date: String,
    amount_minor: i64,
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceInputJson {
    plan: PlanJson,
    #[serde(default)]
    revisions: Vec<RevisionJson>,
    #[serde(default)]
    early_repayments: Vec<RepaymentJson>,
    target_date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FirstCuotaJson {
    amount_minor: i64,
    stub_interest_minor: i64,
    first_principal_minor: i64,
    regular_cuota_minor: i64,
}

fn to_plan(plan: PlanJson) -> AmortizationPlan {
    AmortizationPlan {
        initial_capital_minor: plan.initial_capital_minor,
        annual_interest_rate: plan.annual_interest_rate,
        term_months: plan.term_months,
        disbursement_date: plan.disbursement_date,
        first_payment_date: plan.first_payment_date,
    }
}

fn to_mode(mode: &str) -> EarlyRepaymentMode {
    match mode {
        "reduce-payment" => EarlyRepaymentMode::ReducePayment,
        "reduce-term" => EarlyRepaymentMode::ReduceTerm,
        other => wasm_bindgen::throw_str(&format!("unknown early-repayment mode: {other}")),
    }
}

fn to_balance_input(input: BalanceInputJson) -> BalanceAtDateInput {
    BalanceAtDateInput {
        plan: to_plan(input.plan),
        revisions: input
            .revisions
            .into_iter()
            .map(|r| InterestRateRevision {
                revision_date: r.revision_date,
                new_annual_interest_rate: r.new_annual_interest_rate,
            })
            .collect(),
        early_repayments: input
            .early_repayments
            .into_iter()
            .map(|r| EarlyRepayment {
                repayment_date: r.repayment_date,
                amount_minor: r.amount_minor,
                mode: to_mode(&r.mode),
            })
            .collect(),
        target_date: input.target_date,
    }
}

/// `amortizableBalanceAtDate(input)` — `input` is the JSON of
/// `{ plan, revisions?, earlyRepayments?, targetDate }`. Returns the outstanding
/// balance as an integer minor unit (carried as an f64 — exact for every value
/// below 2^53, far above any realistic balance in cents).
#[wasm_bindgen(js_name = amortizableBalanceAtDate)]
pub fn amortizable_balance_at_date_wasm(input_json: &str) -> f64 {
    let input: BalanceInputJson = serde_json::from_str(input_json)
        .unwrap_or_else(|e| wasm_bindgen::throw_str(&e.to_string()));
    amortizable_balance_at_date(&to_balance_input(input)) as f64
}

/// `firstCuota(plan)` — `plan` is the plan JSON; returns the JSON of the four
/// integer minor-unit fields (`amountMinor`, `stubInterestMinor`,
/// `firstPrincipalMinor`, `regularCuotaMinor`).
#[wasm_bindgen(js_name = firstCuota)]
pub fn first_cuota_wasm(plan_json: &str) -> String {
    let plan: PlanJson =
        serde_json::from_str(plan_json).unwrap_or_else(|e| wasm_bindgen::throw_str(&e.to_string()));
    let cuota = first_cuota(&to_plan(plan));
    let out = FirstCuotaJson {
        amount_minor: cuota.amount_minor,
        stub_interest_minor: cuota.stub_interest_minor,
        first_principal_minor: cuota.first_principal_minor,
        regular_cuota_minor: cuota.regular_cuota_minor,
    };
    serde_json::to_string(&out).expect("FirstCuota serializes")
}

/// `assertEventWithinTerm(plan, eventDate, label)` — throws a JS error (matching
/// the TS engine) when the dated event would fall outside the loan's term.
#[wasm_bindgen(js_name = assertEventWithinTerm)]
pub fn assert_event_within_term_wasm(plan_json: &str, event_date: &str, label: &str) {
    let plan: PlanJson =
        serde_json::from_str(plan_json).unwrap_or_else(|e| wasm_bindgen::throw_str(&e.to_string()));
    if let Err(e) = assert_event_within_term(&to_plan(plan), event_date, label) {
        wasm_bindgen::throw_str(&e.0);
    }
}

/// `addMonths(dateKey, count)` — same-day-of-month month arithmetic with
/// end-of-month clamping.
#[wasm_bindgen(js_name = addMonths)]
pub fn add_months_wasm(date_key: &str, count: i32) -> String {
    add_months(date_key, count as i64)
}

/// `suggestFirstPaymentDate(disbursementDate)` — the editable first-payment
/// default (the 1st, two calendar months out).
#[wasm_bindgen(js_name = suggestFirstPaymentDate)]
pub fn suggest_first_payment_date_wasm(disbursement_date: &str) -> String {
    suggest_first_payment_date(disbursement_date)
}
