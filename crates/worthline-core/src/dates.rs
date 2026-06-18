//! Pure calendar-date helpers over `YYYY-MM-DD` strings (no clock, no I/O).
//!
//! Dates are kept as fixed-width `YYYY-MM-DD` strings so lexicographic ordering
//! equals chronological ordering — the same property the TS engine leans on for
//! its `date < otherDate` comparisons. Arithmetic parses to `(y, m, d)` only
//! where needed, mirroring `amortization.ts` exactly (ADR 0019, #188).

/// Parse a `YYYY-MM-DD` string into `(year, month, day)`.
fn parts(date_key: &str) -> (i64, i64, i64) {
    let year = date_key[0..4].parse::<i64>().expect("valid YYYY");
    let month = date_key[5..7].parse::<i64>().expect("valid MM");
    let day = date_key[8..10].parse::<i64>().expect("valid DD");
    (year, month, day)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Last calendar day of the given 1-based year/month.
fn last_day_of_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => unreachable!("month out of range: {month}"),
    }
}

/// Days from civil date to the epoch, Howard Hinnant's algorithm. Pure calendar
/// arithmetic — matches the TS `daysBetween` (UTC-midnight day difference) with
/// no dependency on a date library.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 }; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Whole days from `from` to `to` (signed), matching TS `daysBetween`.
pub fn days_between(from: &str, to: &str) -> i64 {
    let (fy, fm, fd) = parts(from);
    let (ty, tm, td) = parts(to);
    days_from_civil(ty, tm, td) - days_from_civil(fy, fm, fd)
}

/// The `YYYY-MM-DD` that is `count` whole months after `date_key` (same
/// day-of-month, clamped to the last valid day of the destination month). For
/// example, `2020-01-31 + 1 month → 2020-02-29` (leap year). Mirrors
/// `addMonths` in `amortization.ts` (ADR 0019, #188).
pub fn add_months(date_key: &str, count: i64) -> String {
    let (year, month, day) = parts(date_key);
    let zero_based = month - 1 + count;
    let new_year = year + zero_based.div_euclid(12);
    let new_month = zero_based.rem_euclid(12) + 1;
    let clamped_day = day.min(last_day_of_month(new_year, new_month));
    format!("{new_year:04}-{new_month:02}-{clamped_day:02}")
}

/// The suggested first-payment date for a freshly-entered disbursement: the 1st
/// of the month roughly two months out (the ING "rest of the month + a full
/// month" stub). Mirrors `suggestFirstPaymentDate` (ADR 0019, #189).
pub fn suggest_first_payment_date(disbursement_date: &str) -> String {
    let two_months = add_months(disbursement_date, 2);
    format!("{}-01", &two_months[0..7])
}
