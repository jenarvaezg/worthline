# AI assistance writes through confirmed proposals

AI in worthline may read financial context through the existing **agent view** and may draft an **assistant proposal**, but it does not write holdings, operations, snapshots, imports, or connected-source state directly. The proposal is validated and previewed by worthline, then applied only after explicit user confirmation, preserving the existing manual-first and preview-then-confirm boundaries while still allowing chat, file extraction, and agent analysis to speed up data entry and correction.

This keeps ADR 0023's read-only agent view intact and avoids giving probabilistic model output a privileged write path into sensitive financial history. If a future workflow needs autonomous execution, it should add a narrower domain command with its own validation, audit trail, and confirmation policy rather than weakening this boundary globally.
