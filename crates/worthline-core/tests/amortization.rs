//! Ported amortization cases from `packages/domain/src/amortization.test.ts`.
//!
//! Every pinned euro figure here is the EXACT integer-minor-unit output of the
//! `big.js`-backed TS engine (carried at full precision, rounded to the cent
//! half-up only at the edge). They are the source of truth: the Rust engine
//! must reproduce them to the cent (PRD #280, Module A). The exhaustive fuzz
//! parity lives in the golden-vector gate (#287); this suite is the hand-written
//! oracle.

// The `200_000_00` grouping reads as euros_cents (200.000,00 €), carried
// verbatim from the TS fixtures so the pinned figures line up one-to-one.
#![allow(clippy::inconsistent_digit_grouping)]
// Native-only: the wasm boundary is covered by tests/wasm_boundary.rs.
#![cfg(not(target_arch = "wasm32"))]

use worthline_core::{
    add_months, amortizable_balance_at_date, assert_event_within_term, first_cuota,
    suggest_first_payment_date, AmortizationPlan, BalanceAtDateInput, EarlyRepayment,
    EarlyRepaymentMode, InterestRateRevision,
};

// ---- builders ----------------------------------------------------------------

fn plan(
    rate: &str,
    capital_minor: i64,
    disbursement: &str,
    first_payment: &str,
    term: u32,
) -> AmortizationPlan {
    AmortizationPlan {
        initial_capital_minor: capital_minor,
        annual_interest_rate: rate.to_string(),
        term_months: term,
        disbursement_date: disbursement.to_string(),
        first_payment_date: first_payment.to_string(),
    }
}

fn balance(p: &AmortizationPlan, target: &str) -> i64 {
    amortizable_balance_at_date(&BalanceAtDateInput {
        plan: p.clone(),
        revisions: vec![],
        early_repayments: vec![],
        target_date: target.to_string(),
    })
}

fn balance_with(
    p: &AmortizationPlan,
    revisions: Vec<InterestRateRevision>,
    early_repayments: Vec<EarlyRepayment>,
    target: &str,
) -> i64 {
    amortizable_balance_at_date(&BalanceAtDateInput {
        plan: p.clone(),
        revisions,
        early_repayments,
        target_date: target.to_string(),
    })
}

fn rev(rate: &str, date: &str) -> InterestRateRevision {
    InterestRateRevision {
        revision_date: date.to_string(),
        new_annual_interest_rate: rate.to_string(),
    }
}

fn repay(amount_minor: i64, mode: EarlyRepaymentMode, date: &str) -> EarlyRepayment {
    EarlyRepayment {
        repayment_date: date.to_string(),
        amount_minor,
        mode,
    }
}

use EarlyRepaymentMode::{ReducePayment, ReduceTerm};

// PRD example (backfilled to the two-date model): 200.000€, 2,5%, 360 months.
fn prd_example() -> AmortizationPlan {
    plan("0.025", 200_000_00, "2020-01-01", "2020-02-01", 360)
}

// ---- two-date model — disbursement + first payment (ADR 0019, #188) ----------

fn bank_plan() -> AmortizationPlan {
    plan("0.03", 200_000_00, "2020-01-15", "2020-03-01", 240)
}

#[test]
fn balance_is_flat_between_disbursement_and_first_payment() {
    let p = bank_plan();
    assert_eq!(balance(&p, "2019-12-31"), 200_000_00);
    assert_eq!(balance(&p, "2020-01-15"), 200_000_00);
    assert_eq!(balance(&p, "2020-02-10"), 200_000_00);
    assert_eq!(balance(&p, "2020-02-29"), 200_000_00);
}

#[test]
fn amortizes_from_the_first_payment_on_its_day_of_month() {
    let p = bank_plan();
    assert_eq!(balance(&p, "2020-03-01"), 199_390_80);
    assert_eq!(balance(&p, "2020-04-01"), 198_780_09);
}

#[test]
fn the_term_counts_payments_from_the_first_payment() {
    let p = bank_plan();
    assert_eq!(balance(&p, "2021-03-01"), 191_960_57);
    assert_eq!(balance(&p, "2025-03-01"), 159_909_88);
    assert_eq!(balance(&p, "2040-01-01"), 1_106_43);
    assert_eq!(balance(&p, "2040-02-01"), 0);
    assert_eq!(balance(&p, "2050-01-01"), 0);
}

#[test]
fn backfill_reproduces_the_single_date_curve_to_the_cent() {
    let backfilled = plan("0.025", 200_000_00, "2020-01-01", "2020-02-01", 360);
    assert_eq!(balance(&backfilled, "2020-01-01"), 200_000_00);
    assert_eq!(balance(&backfilled, "2021-01-01"), 195_465_37);
    assert_eq!(balance(&backfilled, "2025-01-01"), 176_150_76);
}

// ---- firstCuota — exact first payment with stub interest (ADR 0019, #190) ----

#[test]
fn first_cuota_stub_interest_from_the_day_count() {
    assert_eq!(first_cuota(&bank_plan()).stub_interest_minor, 76_667);
}

#[test]
fn first_cuota_first_period_principal_is_the_ordinary_french_principal() {
    assert_eq!(first_cuota(&bank_plan()).first_principal_minor, 60_920);
    assert_eq!(balance(&bank_plan(), "2020-03-01"), 200_000_00 - 60_920);
}

#[test]
fn first_cuota_is_stub_interest_plus_first_principal_single_edge_round() {
    let c = first_cuota(&bank_plan());
    assert_eq!(c.amount_minor, 137_586);
    assert!(c.amount_minor > c.regular_cuota_minor);
    assert_eq!(c.regular_cuota_minor, 110_920);
}

#[test]
fn first_cuota_calendar_month_stub_charges_exact_day_count_interest() {
    let monthly_stub = plan("0.03", 200_000_00, "2020-01-01", "2020-02-01", 240);
    let c = first_cuota(&monthly_stub);
    assert_eq!(c.stub_interest_minor, 51_667);
    assert_eq!(c.amount_minor, 112_586);
    assert!(c.amount_minor > c.regular_cuota_minor);
}

#[test]
fn first_cuota_zero_rate_carries_no_stub_interest() {
    let zero_rate = plan("0", 1_200_00, "2020-01-15", "2020-03-01", 12);
    let c = first_cuota(&zero_rate);
    assert_eq!(c.stub_interest_minor, 0);
    assert_eq!(c.first_principal_minor, 100_00);
    assert_eq!(c.amount_minor, 100_00);
    assert_eq!(c.amount_minor, c.regular_cuota_minor);
}

// ---- amortizableBalanceAtDate — French amortization (cuota fija) -------------

#[test]
fn balance_before_the_start_date_is_the_full_initial_capital() {
    let p = prd_example();
    assert_eq!(balance(&p, "2019-06-01"), 200_000_00);
    assert_eq!(balance(&p, "2020-01-01"), 200_000_00);
}

#[test]
fn balance_after_the_final_payment_is_zero() {
    let p = prd_example();
    assert_eq!(balance(&p, "2050-01-01"), 0);
    assert_eq!(balance(&p, "2060-01-01"), 0);
}

#[test]
fn prd_example_exact_balance_after_12_cuotas() {
    assert_eq!(balance(&prd_example(), "2021-01-01"), 195_465_37);
}

#[test]
fn prd_example_exact_balance_after_60_cuotas() {
    assert_eq!(balance(&prd_example(), "2025-01-01"), 176_150_76);
}

#[test]
fn intra_month_interpolation_between_two_cuota_dates() {
    let p = prd_example();
    let on_boundary = balance(&p, "2021-01-01");
    let mid_month = balance(&p, "2021-01-16");
    let next_boundary = balance(&p, "2021-02-01");
    assert!(mid_month < on_boundary);
    assert!(mid_month > next_boundary);
    assert_eq!(mid_month, 195_280_04);
}

#[test]
fn zero_interest_payment_is_capital_over_n_balance_falls_linearly() {
    let zero_rate = plan("0", 1_200_00, "2020-01-01", "2020-02-01", 12);
    assert_eq!(balance(&zero_rate, "2020-07-01"), 600_00);
    assert_eq!(balance(&zero_rate, "2021-01-01"), 0);
}

#[test]
fn a_single_rate_revision_recomputes_the_payment_from_its_date() {
    let p = plan("0.05", 100_000_00, "2020-01-01", "2020-02-01", 120);
    let revisions = vec![rev("0.03", "2022-01-01")]; // after 24 months
    let at_revision = balance_with(&p, revisions.clone(), vec![], "2022-01-01");
    assert_eq!(at_revision, 83_780_56);
    assert_eq!(balance(&p, "2022-01-01"), 83_780_56);

    let revised_later = balance_with(&p, revisions, vec![], "2025-01-01");
    let unrevised_later = balance(&p, "2025-01-01");
    assert!(revised_later < unrevised_later);
}

#[test]
fn multiple_revisions_each_recompute_from_their_own_date() {
    let p = plan("0.05", 100_000_00, "2020-01-01", "2020-02-01", 120);
    let one = vec![rev("0.03", "2022-01-01")];
    let two = vec![rev("0.03", "2022-01-01"), rev("0.07", "2024-01-01")];
    assert_eq!(
        balance_with(&p, one.clone(), vec![], "2024-01-01"),
        balance_with(&p, two.clone(), vec![], "2024-01-01"),
    );
    let after_one = balance_with(&p, one, vec![], "2027-01-01");
    let after_two = balance_with(&p, two, vec![], "2027-01-01");
    assert!(after_two > after_one);
}

// ---- early repayments (amortización anticipada) — PRD #146, slice S4 ---------

fn loan() -> AmortizationPlan {
    plan("0.03", 100_000_00, "2020-01-01", "2020-02-01", 120)
}

#[test]
fn reduce_payment_lump_drops_the_balance_on_its_date_by_the_lump() {
    let p = loan();
    let without = balance(&p, "2022-01-01");
    let with = balance_with(
        &p,
        vec![],
        vec![repay(20_000_00, ReducePayment, "2022-01-01")],
        "2022-01-01",
    );
    assert_eq!(with, without - 20_000_00);
}

#[test]
fn reduce_payment_keeps_the_term_still_owing_near_the_end() {
    let p = loan();
    let near_end = balance_with(
        &p,
        vec![],
        vec![repay(20_000_00, ReducePayment, "2022-01-01")],
        "2029-12-01",
    );
    assert!(near_end > 0);
}

#[test]
fn reduce_term_keeps_the_cuota_same_on_date_paid_off_early() {
    let p = loan();
    let on_date = |mode: EarlyRepaymentMode, target: &str| {
        balance_with(
            &p,
            vec![],
            vec![repay(20_000_00, mode, "2022-01-01")],
            target,
        )
    };
    assert_eq!(
        on_date(ReduceTerm, "2022-01-01"),
        on_date(ReducePayment, "2022-01-01")
    );
    assert!(on_date(ReduceTerm, "2025-01-01") < on_date(ReducePayment, "2025-01-01"));
    assert_eq!(on_date(ReduceTerm, "2029-12-01"), 0);
}

#[test]
fn total_repayment_closes_the_loan_from_its_date_on() {
    let p = loan();
    let repayments = || vec![repay(100_000_00, ReducePayment, "2022-01-01")];
    assert!(balance_with(&p, vec![], repayments(), "2021-12-01") > 0);
    assert_eq!(balance_with(&p, vec![], repayments(), "2022-01-01"), 0);
    assert_eq!(balance_with(&p, vec![], repayments(), "2025-06-01"), 0);
}

#[test]
fn a_repayment_combines_with_a_rate_revision() {
    let p = loan();
    let revisions = vec![rev("0.05", "2021-01-01")]; // month 12
    let with_revision_only = balance_with(&p, revisions.clone(), vec![], "2022-01-01");
    let with_both = balance_with(
        &p,
        revisions,
        vec![repay(20_000_00, ReducePayment, "2022-01-01")],
        "2022-01-01",
    );
    assert_eq!(with_both, with_revision_only - 20_000_00);
}

#[test]
fn a_repayment_has_no_effect_on_dates_before_it() {
    let p = loan();
    let baseline = balance(&p, "2021-01-01");
    let before_future_lump = balance_with(
        &p,
        vec![],
        vec![repay(20_000_00, ReduceTerm, "2022-01-01")],
        "2021-01-01",
    );
    assert_eq!(before_future_lump, baseline);
}

// ---- event month-mapping when the event day precedes the first-payment day (#182)

fn clamping_loan() -> AmortizationPlan {
    plan("0.03", 100_000_00, "2019-12-31", "2020-01-31", 120)
}
const RESOLVED_BOUNDARY: &str = "2021-02-28";
const EVENT_DATE: &str = "2021-02-28";

#[test]
fn lump_whose_day_precedes_start_day_drops_on_date_balance_by_lump() {
    let p = clamping_loan();
    let without = balance(&p, RESOLVED_BOUNDARY);
    let with = balance_with(
        &p,
        vec![],
        vec![repay(20_000_00, ReducePayment, EVENT_DATE)],
        RESOLVED_BOUNDARY,
    );
    assert!((without - with - 20_000_00).abs() <= 1);
}

#[test]
fn early_repayment_day_precedes_start_day_drops_balance_both_modes() {
    let p = clamping_loan();
    for mode in [ReducePayment, ReduceTerm] {
        let without = balance(&p, RESOLVED_BOUNDARY);
        let with = balance_with(
            &p,
            vec![],
            vec![repay(15_000_00, mode, EVENT_DATE)],
            RESOLVED_BOUNDARY,
        );
        assert!((without - with - 15_000_00).abs() <= 1, "mode {mode:?}");
    }
}

#[test]
fn rate_revision_day_precedes_start_day_takes_effect_on_resolved_boundary() {
    let p = clamping_loan();
    for mode in [ReducePayment, ReduceTerm] {
        let revisions = vec![rev("0.06", EVENT_DATE)];
        // One cycle before the resolved boundary the curves coincide.
        let prior = "2021-01-31";
        assert_eq!(
            balance_with(&p, revisions.clone(), vec![], prior),
            balance(&p, prior),
            "mode {mode:?}"
        );
        // From the resolved boundary on, the higher rate leaves a higher balance.
        let later = "2025-02-28";
        assert!(
            balance_with(&p, revisions.clone(), vec![], later) > balance(&p, later),
            "mode {mode:?}"
        );
        // The lump on the same loan + revision drops the on-date balance by the lump.
        let without = balance_with(&p, revisions.clone(), vec![], RESOLVED_BOUNDARY);
        let with = balance_with(
            &p,
            revisions,
            vec![repay(10_000_00, mode, EVENT_DATE)],
            RESOLVED_BOUNDARY,
        );
        assert!((without - with - 10_000_00).abs() <= 1, "mode {mode:?}");
    }
}

// ---- addMonths day-clamping — end-of-month first-payment dates ---------------

#[test]
fn intra_month_interpolation_uses_real_calendar_span_not_rolled_date() {
    let p = plan("0", 2_900_00, "2019-12-31", "2020-01-31", 12);
    assert_eq!(balance(&p, "2020-01-15"), 2_900_00);
    assert_eq!(balance(&p, "2020-01-31"), 265_833);
    assert_eq!(balance(&p, "2020-02-29"), 241_667);
    assert_eq!(balance(&p, "2020-02-15"), 253_333);
}

// ---- determinism (memo #158 ported as purity — Rust engine carries no cache) -

#[test]
fn repeated_and_interleaved_date_queries_are_byte_identical() {
    let p = prd_example();
    let dates = [
        "2020-06-15",
        "2021-01-01",
        "2025-01-01",
        "2021-01-16",
        "2025-01-01",
        "2049-12-01",
    ];
    let reference: Vec<i64> = dates.iter().map(|d| balance(&p, d)).collect();
    for (i, d) in dates.iter().enumerate() {
        assert_eq!(balance(&p, d), reference[i]);
    }
}

#[test]
fn a_revision_changes_the_curve_when_interleaved_with_the_unrevised_loan() {
    let p = prd_example();
    let revisions = vec![rev("0.05", "2022-01-01")];
    let target = "2025-01-01";
    let unrevised = balance(&p, target);
    let revised = balance_with(&p, revisions, vec![], target);
    let unrevised_again = balance(&p, target);
    assert_ne!(revised, unrevised);
    assert!(revised > unrevised);
    assert_eq!(unrevised_again, unrevised);
}

#[test]
fn an_early_repayment_changes_the_curve_when_interleaved() {
    let p = prd_example();
    let repayments = vec![repay(20_000_00, ReduceTerm, "2021-06-01")];
    let target = "2025-01-01";
    let without = balance(&p, target);
    let with = balance_with(&p, vec![], repayments, target);
    let without_again = balance(&p, target);
    assert!(with < without);
    assert_eq!(without_again, without);
}

// ---- assertEventWithinTerm — reject events after the final boundary (#210) ---

fn finite_loan() -> AmortizationPlan {
    plan("0.05", 100_000_00, "2020-01-01", "2020-02-01", 120)
}
const FINAL_BOUNDARY: &str = "2030-01-01";

#[test]
fn far_future_early_repayment_is_rejected_not_dropped() {
    let err = assert_event_within_term(&finite_loan(), "2040-01-01", "Repayment date").unwrap_err();
    assert!(err.0.contains("Repayment date 2040-01-01"));
    assert!(err.0.contains("2030-01-01"));
}

#[test]
fn rate_revision_after_the_final_boundary_is_rejected() {
    let err = assert_event_within_term(&finite_loan(), "2035-06-15", "Revision date").unwrap_err();
    assert!(err.0.contains("Revision date 2035-06-15"));
    assert!(err.0.contains("2030-01-01"));
}

#[test]
fn event_on_the_final_payment_boundary_is_rejected() {
    assert!(assert_event_within_term(&finite_loan(), FINAL_BOUNDARY, "Repayment date").is_err());
}

#[test]
fn event_one_cycle_before_the_final_boundary_is_accepted() {
    assert!(assert_event_within_term(&finite_loan(), "2029-12-01", "Repayment date").is_ok());
}

#[test]
fn event_well_inside_the_term_is_accepted() {
    assert!(assert_event_within_term(&finite_loan(), "2025-01-01", "Revision date").is_ok());
}

#[test]
fn event_before_the_first_payment_is_accepted() {
    assert!(assert_event_within_term(&finite_loan(), "2020-01-10", "Repayment date").is_ok());
}

// ---- suggestFirstPaymentDate — editable first-payment default (ADR 0019, #189)

#[test]
fn suggest_first_payment_mid_month_firma() {
    assert_eq!(suggest_first_payment_date("2026-06-15"), "2026-08-01");
}

#[test]
fn suggest_first_payment_day_is_always_pinned_to_01() {
    assert_eq!(suggest_first_payment_date("2026-06-01"), "2026-08-01");
    assert_eq!(suggest_first_payment_date("2026-06-30"), "2026-08-01");
}

#[test]
fn suggest_first_payment_two_month_offset_rolls_the_year() {
    assert_eq!(suggest_first_payment_date("2026-11-15"), "2027-01-01");
    assert_eq!(suggest_first_payment_date("2026-12-20"), "2027-02-01");
}

#[test]
fn suggest_first_payment_day_31_firma_in_short_target_month() {
    assert_eq!(suggest_first_payment_date("2026-12-31"), "2027-02-01");
}

// ---- addMonths direct (the clamping core the schedule leans on) --------------

#[test]
fn add_months_clamps_to_last_valid_day() {
    assert_eq!(add_months("2020-01-31", 1), "2020-02-29"); // leap
    assert_eq!(add_months("2021-01-31", 1), "2021-02-28"); // non-leap
    assert_eq!(add_months("2020-01-31", 13), "2021-02-28");
}
