//! `worthline-core` — portable Rust core for worthline's net-worth math.
//!
//! First slice (PRD #280): the French **amortization plan** engine ported from
//! `packages/domain/src/amortization.ts`. Pure (no I/O, no clock — every date is
//! an input), arbitrary-precision decimal arithmetic at parity with the
//! `big.js`-backed TS engine, and **integer minor-unit** outputs.
//!
//! Parity is the whole point: the rounded integer balance at every payment date
//! must match the TS engine to the cent, because those values flow into frozen
//! snapshots (ADR 0008) and trigger ripple recalculation (ADR 0012).

mod decimal;

pub mod amortization;
pub mod dates;

// The JS↔WASM binding (Module B, #290) — only on wasm32, so native builds and
// `cargo test` never pull wasm-bindgen.
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use amortization::{
    amortizable_balance_at_date, assert_event_within_term, first_cuota, AmortizationError,
    AmortizationPlan, BalanceAtDateInput, EarlyRepayment, EarlyRepaymentMode, FirstCuota,
    InterestRateRevision,
};
pub use dates::{add_months, suggest_first_payment_date};
