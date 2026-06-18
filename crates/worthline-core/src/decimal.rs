//! big.js-parity decimal helpers.
//!
//! The TS engine is backed by `big.js` with its defaults (`DP = 20`, `RM = 1` =
//! round-half-up). Addition, subtraction and multiplication are EXACT in both
//! `big.js` and `bigdecimal`; the only rounding happens on **division** (to 20
//! decimal places, half-up) and at the **decimal→minor-unit edge** (to a whole
//! integer, half-up). `RoundingMode::HalfUp` rounds half AWAY from zero, exactly
//! like `Big.roundHalfUp`.
//!
//! Parity is defined on the final rounded INTEGER minor units only — internal
//! precision need not match `big.js` digit-for-digit (PRD #280).

use std::str::FromStr;

use bigdecimal::{BigDecimal, RoundingMode};
use num_traits::ToPrimitive;

/// Decimal places carried on division, matching `big.js`'s default `DP`.
const DIVISION_DECIMAL_PLACES: i64 = 20;

/// Parse a decimal-string rate (e.g. `"0.025"`) the way the domain represents it.
pub fn decimal(value: &str) -> BigDecimal {
    BigDecimal::from_str(value).expect("annual interest rate must be a decimal string")
}

/// An integer minor-unit value (e.g. cents) as an exact decimal.
pub fn from_minor(value: i64) -> BigDecimal {
    BigDecimal::from(value)
}

/// An integer count (term in months, day count, divisor) as an exact decimal.
pub fn from_int(value: i64) -> BigDecimal {
    BigDecimal::from(value)
}

/// `a / b` rounded to 20 decimal places, half-up — `big.js`'s `Big.div` default.
pub fn div(a: &BigDecimal, b: &BigDecimal) -> BigDecimal {
    (a / b).with_scale_round(DIVISION_DECIMAL_PLACES, RoundingMode::HalfUp)
}

/// Round a decimal minor-unit value to a whole integer minor unit, half-up.
/// A negative value clamps to 0, mirroring `toMinorInt` (a paid-off balance can
/// undershoot zero by rounding noise and must never read as negative debt).
pub fn to_minor_int(value: &BigDecimal) -> i64 {
    if value < &BigDecimal::from(0) {
        return 0;
    }
    value
        .with_scale_round(0, RoundingMode::HalfUp)
        .to_i64()
        .expect("rounded minor-unit value fits in i64")
}
