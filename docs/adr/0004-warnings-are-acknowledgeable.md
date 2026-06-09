# Zero-value (and future) warnings are acknowledgeable, not just informational

The domain already models warning `severity` as `blocking | overrideable`; we will
honor it in the UI. An **overrideable** warning (today: an asset left at value 0,
`ZERO_VALUE_ASSET`) links to the offending holding and can be marked intentional,
which persists an **override** that suppresses that warning. **Blocking** warnings
cannot be dismissed.

We considered always warning until the value changes (which leaves the
`overrideable` field dormant) and only warning on a value that regressed to 0 (which
needs valuation history we don't keep).

## Consequences

- Honoring overrides adds persisted state — an override store keyed by warning code
  + entity. This is a schema decision and follows the forward-migration approach in
  [ADR 0002](./0002-forward-migration-with-drizzle.md).
- The warning channel becomes trustworthy: a surfaced warning is either actionable or
  a deliberate, acknowledged state — never permanent noise.
