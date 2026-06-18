//! WASM boundary tests (Module B, PRD #280 / issue #290).
//!
//! Run with `wasm-pack test --node -p worthline-core`. These exercise the
//! JS↔WASM binding itself — the JSON marshalling of decimal strings + integers
//! and the integer/JSON results — on the wasm32 target, asserting the SAME
//! pinned figures the native suite (#286) and the parity gate (#287) pin. The
//! synchronous-after-init contract is a property of the `--target nodejs`
//! loader and is exercised by the Vitest smoke test on the built package.

#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::wasm_bindgen_test;
use worthline_core::wasm::{
    add_months_wasm, amortizable_balance_at_date_wasm, assert_event_within_term_wasm,
    first_cuota_wasm, suggest_first_payment_date_wasm,
};

const PRD_PLAN: &str = r#"{"initialCapitalMinor":20000000,"annualInterestRate":"0.025","termMonths":360,"disbursementDate":"2020-01-01","firstPaymentDate":"2020-02-01"}"#;
const BANK_PLAN: &str = r#"{"initialCapitalMinor":20000000,"annualInterestRate":"0.03","termMonths":240,"disbursementDate":"2020-01-15","firstPaymentDate":"2020-03-01"}"#;
const LOAN: &str = r#"{"initialCapitalMinor":10000000,"annualInterestRate":"0.03","termMonths":120,"disbursementDate":"2020-01-01","firstPaymentDate":"2020-02-01"}"#;

#[wasm_bindgen_test]
fn balance_marshals_and_matches_the_pinned_value() {
    let input = format!(r#"{{"plan":{PRD_PLAN},"targetDate":"2021-01-01"}}"#);
    assert_eq!(amortizable_balance_at_date_wasm(&input), 19_546_537.0);

    let bank = format!(r#"{{"plan":{BANK_PLAN},"targetDate":"2020-03-01"}}"#);
    assert_eq!(amortizable_balance_at_date_wasm(&bank), 19_939_080.0);
}

#[wasm_bindgen_test]
fn balance_honours_revisions_and_repayments_across_the_boundary() {
    let without = amortizable_balance_at_date_wasm(&format!(
        r#"{{"plan":{LOAN},"targetDate":"2022-01-01"}}"#
    ));
    let with = amortizable_balance_at_date_wasm(&format!(
        r#"{{"plan":{LOAN},"earlyRepayments":[{{"repaymentDate":"2022-01-01","amountMinor":2000000,"mode":"reduce-payment"}}],"targetDate":"2022-01-01"}}"#
    ));
    // The lump drops the on-date balance by exactly the lump (200.000 cents).
    assert_eq!(with, without - 2_000_000.0);
}

#[wasm_bindgen_test]
fn first_cuota_marshals_the_four_integer_fields() {
    // Exact compact JSON in struct field order — proves the result marshalling.
    assert_eq!(
        first_cuota_wasm(BANK_PLAN),
        r#"{"amountMinor":137586,"stubInterestMinor":76667,"firstPrincipalMinor":60920,"regularCuotaMinor":110920}"#
    );
}

#[wasm_bindgen_test]
fn date_helpers_cross_the_boundary() {
    assert_eq!(add_months_wasm("2020-01-31", 1), "2020-02-29"); // leap clamp
    assert_eq!(suggest_first_payment_date_wasm("2026-06-15"), "2026-08-01");
}

#[wasm_bindgen_test]
fn assert_event_within_term_accepts_an_in_range_event() {
    // In range → must not throw (the out-of-range throw is covered natively, #286).
    assert_event_within_term_wasm(BANK_PLAN, "2025-03-01", "Repayment date");
}
