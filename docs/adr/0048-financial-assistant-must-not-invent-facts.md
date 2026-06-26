# The financial assistant must not invent facts

worthline's **financial assistant** may reason, recommend, and build scenarios, but it must not fill missing workspace facts with invented values. When data is absent, stale, or insufficient, the assistant says so; any estimate is labelled as a scenario assumption rather than presented as workspace truth.

This is stricter than ordinary chat helpfulness because worthline's domain is financial history and planning. A guessed mortgage rate, price history, tax treatment, or holding balance can corrupt the user's understanding even if no write occurs, so uncertainty must remain visible in the answer and in any future **assistant proposal**.
