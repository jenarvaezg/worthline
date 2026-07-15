# First assistant actions are read-only quick actions

The first **financial assistant** slice may suggest **assistant quick actions** that navigate, change the current view, or run another read-only analysis, such as opening a holding detail, showing monthly history for a scope, or comparing amortization versus investing under labelled assumptions. These actions keep the assistant layer open and do not mutate workspace data.

The initial action set is intentionally small:

- `openInternalSource` — navigate to a worthline surface for a cited internal source.
- `runSuggestedAnalysis` — start a follow-up read-only analysis from a model-suggested prompt or intent.

The model may propose actions, but the app only renders actions that validate against this typed set.

Write-capable actions are deliberately excluded from this first action model. When the assistant later needs to create or correct data, it should draft an **assistant proposal** with validation, preview, and explicit confirmation instead of reusing the quick-action path.

## Amendment: confirmed proposal actions

Issue #706 adds the first write-capable assistant action class without changing the quick-action contract. `suggest_actions` remains read-only. Write-capable assistant output is a separate **confirmed proposal**: the model calls a proposal tool (`propose_exposure_profiles`) whose output writes nothing, the chat layer renders a before/after preview, and only an explicit user confirmation invokes a server action.

Confirmed proposal actions must re-validate on the server before writing, must be rejectable without side effects, and must no-op in demo mode. Future import/fix proposals should copy this shape rather than extending read-only quick actions.

**Amendment (#1014):** `propose_exposure_profiles` was removed. Exposure profiles are admin-only (ADR 0058); the assistant no longer drafts profile writes.
