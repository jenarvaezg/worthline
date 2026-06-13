# Export/import carries the full holding model

The export was frozen when only investments had structure, so it silently dropped
everything later features added — appreciation rates, valuation anchors, debt models,
amortization plans, interest-rate revisions, and balance anchors — meaning an export→import
round-trip turned an amortizing debt back into a flat line, violating ADR 0010's "faithful
restore". Now that a holding's structure (its **instrument**, **valuation method**, and all
dated facts) is first-class, the serialized payload is reset to carry the entire model.
Because no production exports exist yet, the lossy old shape is abandoned with no converter;
ADR 0010's versioned, all-or-nothing full-replace mechanism is otherwise unchanged.
