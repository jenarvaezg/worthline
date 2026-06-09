# Snapshots are captured automatically; the monthly close is derived

Snapshots were a manual act — a "Guardar snapshot" button with "Cierre mensual" and
"Reemplazar hoy" checkboxes — so the history (and the dashboard deltas that read from
it) only existed if the user remembered to press it. We decided snapshots are not a
user act: the app captures at most one snapshot per scope per day, the day's latest
capture winning, and the **monthly close** is derived as the last snapshot of each
calendar month. The user-declared `isMonthlyClose` flag is retired.

We considered keeping the monthly close as an explicit user act (it carried "I
reviewed my data and certify this close" semantics, and was the recommended option)
but chose full automation: zero-friction history beats the certification ritual in a
single-user app, and a derived close can never be forgotten.

## Consequences

- The dashboard deltas (vs previous snapshot, vs monthly close) always have data
  after the first day of use.
- A monthly close no longer implies the data was reviewed — it is just the last day
  that month the app captured. The "reviewed" signal, if ever needed again, must
  come back as a separate concept, not by overloading the close.
- Existing persisted `isMonthlyClose` flags become advisory at best; derivation wins.
  Schema changes follow the forward-migration approach in
  [ADR 0002](./0002-forward-migration-with-drizzle.md).
- The snapshot save form, its checkboxes, and the "save" vocabulary leave the UI
  (see CONTEXT.md: _avoid "guardar snapshot" as a user-facing action_).
