//! French-amortization (cuota fija) balance curve, ported from
//! `packages/domain/src/amortization.ts`. See that module for the full model
//! commentary; this is a faithful re-expression, not a redesign.
//!
//! Model (ADR 0019, #188): a plan carries a DISBURSEMENT date (the debt appears
//! at its initial capital) and a FIRST-PAYMENT date (the balance amortizes from
//! here, on this date's day-of-month, term counted from here). Between the two
//! the balance is FLAT — the stub interest only enlarges the displayed first
//! cuota and never moves the curve. A rate revision recomputes the payment from
//! its month boundary over the remaining term; an early repayment drops the live
//! balance at its boundary and either lowers the cuota (reduce-payment) or
//! shortens the term (reduce-term).
//!
//! All arithmetic is exact except division (20 dp, half-up) and the final
//! decimal→minor-unit edge round, mirroring `big.js`'s defaults. The boundary
//! curve is rebuilt per call: the TS memo (#158) is a perf optimization with
//! byte-identical output and is out of scope for Module A (PRD #280).

use std::collections::HashMap;

use bigdecimal::BigDecimal;
use num_traits::Zero;

use crate::dates::{add_months, days_between};
use crate::decimal::{decimal, div, from_int, from_minor, to_minor_int};

/// A rate revision: the new annual rate takes effect from `revision_date`.
#[derive(Debug, Clone)]
pub struct InterestRateRevision {
    /// `YYYY-MM-DD` the new rate takes effect from.
    pub revision_date: String,
    /// Decimal-string annual rate, e.g. `"0.03"`.
    pub new_annual_interest_rate: String,
}

/// How an early repayment reshapes the remaining schedule (PRD #146).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EarlyRepaymentMode {
    /// Keep the end date, lower the cuota over the remaining term.
    ReducePayment,
    /// Keep the cuota, reach zero earlier.
    ReduceTerm,
}

/// A lump-sum early repayment (amortización anticipada) against the principal.
#[derive(Debug, Clone)]
pub struct EarlyRepayment {
    /// `YYYY-MM-DD` the repayment is made.
    pub repayment_date: String,
    /// Principal repaid, integer minor units.
    pub amount_minor: i64,
    /// Keep the term and lower the cuota, or keep the cuota and shorten the term.
    pub mode: EarlyRepaymentMode,
}

/// An amortization plan: the loan's terms under the two-date model (ADR 0019).
#[derive(Debug, Clone)]
pub struct AmortizationPlan {
    /// Initial borrowed capital, integer minor units.
    pub initial_capital_minor: i64,
    /// Decimal-string annual interest rate, e.g. `"0.025"`.
    pub annual_interest_rate: String,
    /// Loan term in whole months (payments counted from the first payment).
    pub term_months: u32,
    /// Disbursement date (firma / devengo), `YYYY-MM-DD`.
    pub disbursement_date: String,
    /// First-payment date, `YYYY-MM-DD`.
    pub first_payment_date: String,
}

/// Inputs to value the outstanding balance on a given date.
#[derive(Debug, Clone)]
pub struct BalanceAtDateInput {
    pub plan: AmortizationPlan,
    /// Rate revisions in any order; applied from each revision's month boundary.
    pub revisions: Vec<InterestRateRevision>,
    /// Early repayments in any order; applied from each repayment's month boundary.
    pub early_repayments: Vec<EarlyRepayment>,
    /// The date to value the outstanding balance on, `YYYY-MM-DD`.
    pub target_date: String,
}

/// The exact first cuota broken down for display (ADR 0019, #190).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstCuota {
    /// The exact first cuota, integer minor units (stub interest + first principal).
    pub amount_minor: i64,
    /// Stub interest of the disbursement→first-payment period, integer minor units.
    pub stub_interest_minor: i64,
    /// First-period ordinary French principal, integer minor units.
    pub first_principal_minor: i64,
    /// The regular (subsequent) cuota for comparison, integer minor units.
    pub regular_cuota_minor: i64,
}

/// A dated event falls outside the loan's term and would be silently dropped
/// (#210). The TS engine throws; the Rust engine returns this error so callers
/// guard with the same rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmortizationError(pub String);

impl std::fmt::Display for AmortizationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AmortizationError {}

// ---- internal helpers --------------------------------------------------------

/// The monthly rate for a decimal-string annual rate: `annual / 12` at 20 dp.
fn monthly_rate_of(annual_rate: &str) -> BigDecimal {
    div(&decimal(annual_rate), &from_int(12))
}

/// Fixed monthly payment (cuota francesa) for the given capital, monthly rate,
/// and term. `i = 0` falls back to `capital / n` (avoids dividing by zero).
fn monthly_payment(
    capital: &BigDecimal,
    monthly_rate: &BigDecimal,
    term_months: u32,
) -> BigDecimal {
    if monthly_rate.is_zero() {
        return div(capital, &from_int(term_months as i64));
    }
    let one_plus = monthly_rate + BigDecimal::from(1);
    let mut factor = BigDecimal::from(1);
    for _ in 0..term_months {
        factor *= one_plus.clone();
    }
    let numerator = capital * (monthly_rate * factor.clone());
    div(&numerator, &(factor - BigDecimal::from(1)))
}

/// The annual rate in effect on month `month_index` (0-based), honouring
/// revisions. Mirrors the TS string-equality semantics exactly.
fn annual_rate_for_month(
    base_annual_rate: &str,
    sorted_revisions: &[(u32, String)],
    month_index: u32,
) -> String {
    let mut rate = base_annual_rate.to_string();
    for (revision_month, revision_rate) in sorted_revisions {
        if *revision_month <= month_index {
            rate = revision_rate.clone();
        }
    }
    rate
}

/// The date of schedule boundary `m` (ADR 0019, #188). Boundary 0 is the
/// disbursement; boundary `m ≥ 1` is `first_payment + (m − 1) months`.
fn boundary_date(plan: &AmortizationPlan, m: u32) -> String {
    if m == 0 {
        plan.disbursement_date.clone()
    } else {
        add_months(&plan.first_payment_date, (m - 1) as i64)
    }
}

/// The schedule boundary index a dated event lands on: the largest `m` with
/// `boundary_date(plan, m) ≤ event_date`. Floored at 0 for events on/before the
/// disbursement. Mirrors `monthIndexForDate` (#182, two-date model #188).
fn month_index_for_date(plan: &AmortizationPlan, event_date: &str) -> u32 {
    if event_date < plan.first_payment_date.as_str() {
        return 0;
    }
    let from_year: i64 = plan.first_payment_date[0..4].parse().unwrap();
    let from_month: i64 = plan.first_payment_date[5..7].parse().unwrap();
    let to_year: i64 = event_date[0..4].parse().unwrap();
    let to_month: i64 = event_date[5..7].parse().unwrap();
    let calendar_months = (to_year - from_year) * 12 + (to_month - from_month);
    let mut month_index = calendar_months.max(1);
    while boundary_date(plan, (month_index + 1) as u32).as_str() <= event_date {
        month_index += 1;
    }
    month_index as u32
}

/// Build the balance at the start of each month `[0..=term_months]`. Element 0
/// is the initial capital; element `term_months` is the fully-repaid balance.
fn compute_boundaries(input: &BalanceAtDateInput) -> Vec<BigDecimal> {
    let plan = &input.plan;
    let term_months = plan.term_months;

    let mut sorted_revisions: Vec<(u32, String)> = input
        .revisions
        .iter()
        .map(|r| {
            (
                month_index_for_date(plan, &r.revision_date),
                r.new_annual_interest_rate.clone(),
            )
        })
        .collect();
    sorted_revisions.sort_by_key(|a| a.0); // stable, preserves input order within a month

    // Early repayments grouped by the month boundary they land on; input order
    // within a month is preserved for determinism.
    let mut repayments_by_month: HashMap<u32, Vec<&EarlyRepayment>> = HashMap::new();
    for repayment in &input.early_repayments {
        let month_index = month_index_for_date(plan, &repayment.repayment_date);
        repayments_by_month
            .entry(month_index)
            .or_default()
            .push(repayment);
    }

    let zero = BigDecimal::from(0);
    let mut boundaries: Vec<BigDecimal> = vec![from_minor(plan.initial_capital_minor)];
    let mut balance = from_minor(plan.initial_capital_minor);
    let mut payment = monthly_payment(
        &balance,
        &monthly_rate_of(&plan.annual_interest_rate),
        term_months,
    );
    let mut active_rate = plan.annual_interest_rate.clone();

    for month_index in 0..term_months {
        let rate_for_month =
            annual_rate_for_month(&plan.annual_interest_rate, &sorted_revisions, month_index);
        if rate_for_month != active_rate {
            active_rate = rate_for_month;
            let remaining_term = term_months - month_index;
            payment = monthly_payment(&balance, &monthly_rate_of(&active_rate), remaining_term);
        }

        if let Some(repayments) = repayments_by_month.get(&month_index) {
            for repayment in repayments {
                balance -= from_minor(repayment.amount_minor);
                if balance < zero {
                    balance = zero.clone();
                }
                if repayment.mode == EarlyRepaymentMode::ReducePayment {
                    let remaining_term = term_months - month_index;
                    payment =
                        monthly_payment(&balance, &monthly_rate_of(&active_rate), remaining_term);
                }
            }
            // The lump lands at the start of this month, so the balance ON the
            // boundary reflects it — overwrite the pre-lump start-of-month value.
            boundaries[month_index as usize] = balance.clone();
        }

        let monthly_rate = monthly_rate_of(&active_rate);
        let interest = &balance * &monthly_rate;
        let principal = &payment - &interest;
        balance -= principal;
        if balance < zero {
            balance = zero.clone();
        }
        boundaries.push(balance.clone());
    }

    boundaries
}

// ---- public API --------------------------------------------------------------

/// Outstanding principal on `target_date`, in integer minor units (half up).
/// Before the first payment → the full initial capital (flat). On/after the
/// final payment → 0. Otherwise the boundary balance the target falls in, less
/// the principal amortized to the next boundary prorated by days elapsed (linear
/// intra-month interpolation). The stub (boundary 0→1) is never interpolated.
pub fn amortizable_balance_at_date(input: &BalanceAtDateInput) -> i64 {
    let plan = &input.plan;
    let target_date = input.target_date.as_str();

    if target_date < plan.first_payment_date.as_str() {
        return plan.initial_capital_minor;
    }

    let boundaries = compute_boundaries(input);
    let end_date = boundary_date(plan, plan.term_months);
    if target_date >= end_date.as_str() {
        return 0;
    }

    // Locate the boundary the target falls in: the largest m with
    // boundary_date ≤ target. The target is on/after the first payment, so m ≥ 1.
    let mut month_index: u32 = 1;
    for m in 1..plan.term_months {
        if boundary_date(plan, m).as_str() <= target_date {
            month_index = m;
        } else {
            break;
        }
    }

    let month_start = boundary_date(plan, month_index);
    let month_end = boundary_date(plan, month_index + 1);
    let start_balance = &boundaries[month_index as usize];
    let end_balance = &boundaries[(month_index + 1) as usize];

    let span = days_between(&month_start, &month_end);
    let offset = days_between(&month_start, target_date);
    let fraction = if span == 0 {
        BigDecimal::from(0)
    } else {
        div(&from_int(offset), &from_int(span))
    };
    let amortized_this_month = (start_balance - end_balance) * fraction;
    to_minor_int(&(start_balance - amortized_this_month))
}

/// The exact first cuota of an amortization plan (ADR 0019, #190). The opening
/// period (disbursement → first payment) is longer than a month, so the first
/// cuota carries the stub interest for that period plus that period's ordinary
/// French principal. DISPLAY ONLY — never moves the balance curve.
pub fn first_cuota(plan: &AmortizationPlan) -> FirstCuota {
    let capital = from_minor(plan.initial_capital_minor);
    let annual_rate = decimal(&plan.annual_interest_rate);
    let monthly_rate = monthly_rate_of(&plan.annual_interest_rate);

    let cuota = monthly_payment(&capital, &monthly_rate, plan.term_months);
    let first_principal = &cuota - &(&capital * &monthly_rate);

    let stub_days = days_between(&plan.disbursement_date, &plan.first_payment_date);
    let stub_interest = div(
        &(&capital * &annual_rate * from_int(stub_days)),
        &from_int(360),
    );

    FirstCuota {
        amount_minor: to_minor_int(&(&stub_interest + &first_principal)),
        stub_interest_minor: to_minor_int(&stub_interest),
        first_principal_minor: to_minor_int(&first_principal),
        regular_cuota_minor: to_minor_int(&cuota),
    }
}

/// Reject a dated event that falls after the loan's final payment boundary
/// (#210). Such an event resolves to `month_index ≥ term_months`, which the
/// build loop never reads, so it would be silently dropped. Pure — reads no
/// clock — so any caller can guard with the same rule.
pub fn assert_event_within_term(
    plan: &AmortizationPlan,
    event_date: &str,
    label: &str,
) -> Result<(), AmortizationError> {
    if month_index_for_date(plan, event_date) >= plan.term_months {
        let final_boundary = boundary_date(plan, plan.term_months);
        return Err(AmortizationError(format!(
            "{label} {event_date} is after the loan's final payment boundary ({final_boundary}); \
             it would fall outside the {}-month term and be silently dropped.",
            plan.term_months
        )));
    }
    Ok(())
}
