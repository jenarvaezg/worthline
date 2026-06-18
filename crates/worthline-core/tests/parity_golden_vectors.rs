//! Golden-vector parity gate (PRD #280, Module C / issue #287) — the
//! make-or-break check.
//!
//! The `big.js`-backed TS engine is the oracle: a seeded generator dumps, for
//! each plan, `firstCuota` and the outstanding balance at every sampled date
//! (every payment boundary across the full range — i.e. the schedule — plus
//! intra-month samples and out-of-range probes) into
//! `tests/fixtures/golden-vectors.json`. This harness feeds the SAME plan inputs
//! into the Rust engine and asserts the results are **integer-identical**.
//!
//! Parity is defined ONLY on the rounded integer minor units — the values that
//! flow into frozen snapshots (ADR 0008) and trigger ripple recalculation (ADR
//! 0012). A single divergent cent here would rewrite history; the gate fails
//! loudly with the offending plan, date, and expected/actual.
//!
//! Regenerate the fixture with:
//!   npx tsx crates/worthline-core/parity/generate-golden-vectors.ts

#![allow(clippy::inconsistent_digit_grouping)]

use serde::Deserialize;
use worthline_core::{
    amortizable_balance_at_date, first_cuota, AmortizationPlan, BalanceAtDateInput, EarlyRepayment,
    EarlyRepaymentMode, InterestRateRevision,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    #[allow(dead_code)]
    seed: u64,
    vector_count: u32,
    balance_case_count: u32,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    label: String,
    plan: PlanJson,
    revisions: Vec<RevJson>,
    early_repayments: Vec<RepayJson>,
    first_cuota: CuotaJson,
    balances: Vec<BalanceCase>,
}

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
struct RevJson {
    revision_date: String,
    new_annual_interest_rate: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepayJson {
    repayment_date: String,
    amount_minor: i64,
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CuotaJson {
    amount_minor: i64,
    stub_interest_minor: i64,
    first_principal_minor: i64,
    regular_cuota_minor: i64,
}

#[derive(Deserialize)]
struct BalanceCase {
    date: String,
    expected: i64,
}

fn to_mode(mode: &str) -> EarlyRepaymentMode {
    match mode {
        "reduce-payment" => EarlyRepaymentMode::ReducePayment,
        "reduce-term" => EarlyRepaymentMode::ReduceTerm,
        other => panic!("unknown early-repayment mode in fixture: {other}"),
    }
}

impl Vector {
    fn plan(&self) -> AmortizationPlan {
        AmortizationPlan {
            initial_capital_minor: self.plan.initial_capital_minor,
            annual_interest_rate: self.plan.annual_interest_rate.clone(),
            term_months: self.plan.term_months,
            disbursement_date: self.plan.disbursement_date.clone(),
            first_payment_date: self.plan.first_payment_date.clone(),
        }
    }

    fn revisions(&self) -> Vec<InterestRateRevision> {
        self.revisions
            .iter()
            .map(|r| InterestRateRevision {
                revision_date: r.revision_date.clone(),
                new_annual_interest_rate: r.new_annual_interest_rate.clone(),
            })
            .collect()
    }

    fn repayments(&self) -> Vec<EarlyRepayment> {
        self.early_repayments
            .iter()
            .map(|r| EarlyRepayment {
                repayment_date: r.repayment_date.clone(),
                amount_minor: r.amount_minor,
                mode: to_mode(&r.mode),
            })
            .collect()
    }
}

fn load_fixture() -> Fixture {
    let path = format!(
        "{}/tests/fixtures/golden-vectors.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "golden-vector fixture missing at {path}: {e}\n\
             Regenerate it with: npx tsx crates/worthline-core/parity/generate-golden-vectors.ts"
        )
    });
    serde_json::from_str(&raw).expect("golden-vector fixture is valid JSON")
}

/// The make-or-break: the Rust engine reproduces the TS `big.js` engine to the
/// cent across every fixture and fuzzed plan.
#[test]
fn rust_engine_is_integer_identical_to_the_ts_golden_vectors() {
    let fixture = load_fixture();

    // Guard against a truncated/empty fixture silently passing the gate.
    assert_eq!(
        fixture.vectors.len() as u32,
        fixture.vector_count,
        "fixture header vectorCount must match the body"
    );
    assert!(
        fixture.vectors.len() >= 50,
        "expected a broad fuzz, got only {} vectors",
        fixture.vectors.len()
    );

    let mut total_cases: u32 = 0;
    let mut mismatch_count = 0usize;
    let mut examples: Vec<String> = Vec::new();
    let mut record = |line: String| {
        mismatch_count += 1;
        if examples.len() < 25 {
            examples.push(line);
        }
    };

    for v in &fixture.vectors {
        let plan = v.plan();
        let revisions = v.revisions();
        let repayments = v.repayments();

        let fc = first_cuota(&plan);
        if fc.amount_minor != v.first_cuota.amount_minor
            || fc.stub_interest_minor != v.first_cuota.stub_interest_minor
            || fc.first_principal_minor != v.first_cuota.first_principal_minor
            || fc.regular_cuota_minor != v.first_cuota.regular_cuota_minor
        {
            record(format!(
                "[{}] firstCuota TS=(amt {},stub {},prin {},reg {}) RUST=(amt {},stub {},prin {},reg {})",
                v.label,
                v.first_cuota.amount_minor,
                v.first_cuota.stub_interest_minor,
                v.first_cuota.first_principal_minor,
                v.first_cuota.regular_cuota_minor,
                fc.amount_minor,
                fc.stub_interest_minor,
                fc.first_principal_minor,
                fc.regular_cuota_minor,
            ));
        }

        for case in &v.balances {
            total_cases += 1;
            let got = amortizable_balance_at_date(&BalanceAtDateInput {
                plan: plan.clone(),
                revisions: revisions.clone(),
                early_repayments: repayments.clone(),
                target_date: case.date.clone(),
            });
            if got != case.expected {
                record(format!(
                    "[{}] balance@{} TS={} RUST={} (Δ={})",
                    v.label,
                    case.date,
                    case.expected,
                    got,
                    got - case.expected
                ));
            }
        }
    }

    assert_eq!(
        total_cases, fixture.balance_case_count,
        "fixture header balanceCaseCount must match the body"
    );
    assert!(
        total_cases >= 3000,
        "expected dense sampling, got only {total_cases} balance cases"
    );

    assert!(
        mismatch_count == 0,
        "PARITY BROKEN — {mismatch_count} mismatch(es) over {total_cases} cases:\n{}",
        examples.join("\n")
    );

    eprintln!(
        "parity OK: {} vectors, {} integer-identical balance cases",
        fixture.vectors.len(),
        total_cases
    );
}

/// The gate must actually bite: prove the comparison detects a one-cent drift —
/// the exact failure mode (a ripple rewriting history) the gate exists to stop.
#[test]
fn the_gate_detects_a_one_cent_divergence() {
    let plan = AmortizationPlan {
        initial_capital_minor: 200_000_00,
        annual_interest_rate: "0.025".to_string(),
        term_months: 360,
        disbursement_date: "2020-01-01".to_string(),
        first_payment_date: "2020-02-01".to_string(),
    };
    let got = amortizable_balance_at_date(&BalanceAtDateInput {
        plan,
        revisions: vec![],
        early_repayments: vec![],
        target_date: "2021-01-01".to_string(),
    });
    assert_eq!(got, 195_465_37, "the true balance");
    assert_ne!(
        got,
        195_465_37 + 1,
        "a one-cent drift would be caught by the gate"
    );
}
