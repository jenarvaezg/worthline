# A drafted proposal is applied through one gate

- Status: accepted
- Date: 2026-08-26
- Issue: #1591

## Context

Ten kinds of assistant proposal could be applied, and the command host had ten
methods to apply them — `applyAssistantStatementProposal`,
`applyAssistantMixedProposal`, `applyAssistantReconcileProposal`,
`applyAssistantOperationProposal`, `applyAssistantTransferProposal`,
`applyAssistantBalanceHistoryProposal`,
`applyAssistantPropertyValuationProposal`,
`applyAssistantPropertyAcquisitionProposal`,
`applyAssistantEarlyRepaymentProposal`, `applyAssistantCorrectionProposal`.

Each was the same twenty lines: call the shared `applyDraftAssistantProposal`,
pass a closure that re-checks the kind and throws its own sentence, pass a second
closure with the write, and stamp `trigger: "assistant"` on it. The ceremony —
read the draft, refuse a kind that does not match, refuse a draft that is already
resolved, write, mark applied, all inside ONE transaction — was stated ten times.

Two costs, both paid in 2026. Every new kind of proposal (the reconcile #1108,
the dated operation #1374, the dictated traspaso #1482, the acquisition #1563)
began by cloning the previous kind's method, so the invariant lived in ten copies
that had to agree. And `host.ts` grew to 893 lines: 450 of them the applies and
the correction machinery they call, which buried the file's actual job —
assembling seams.

This is the same shape as the chat tool catalog (ADR 0086), the control plane
(ADR 0087) and the assistant's cards (ADR 0088): a grab-bag that grew by
appending, split into a registry plus one member per row.

## Decision

Applying a drafted proposal is **one gate with a table of kinds**.

- **One public method.** `CommandHost.applyAssistantProposal({ kind, proposalId,
  … })` replaces the ten. It does not widen the intent-shaped surface ADR 0062
  asks for: the intent *is* «apply this drafted proposal», and the kind is which
  proposal, not which method.
- **The ceremony is stated once**, in `createApplyAssistantProposal`
  (`commands/assistant-proposal-apply.ts`): one `ctx.transaction`, the
  not-found / wrong-kind / already-resolved refusals, the write, `markApplied`.
- **A kind is a row.** `ASSISTANT_PROPOSAL_APPLIERS` maps kind → the write, and
  a row IS the write: no status guard, no re-read of the draft, no `markApplied`.
  The row receives the seams, its own params, and the draft the gate already read
  inside the transaction.
- **The table types the call.** `AssistantProposalApplyKind`, what else the call
  takes, and what it answers with are all derived from the table, so a caller
  cannot pass a reconcile's curated batch under a correction's name, and the two
  kinds that answer with `DebtRippleCounts` still do.
- **The identity fields are the gate's.** `kind` and `proposalId` are stripped
  before the row sees its params — three rows spread their params straight into
  the statement-import seam, and the engine has no business receiving them.
- **The correction keeps its own module.** `assistant-correction-apply.ts` holds
  both depths (the anchor-only edit loop of #1051 and the reconstruct import of
  #1053); its row only routes between them.

What does NOT change: the writes. Same seams, same `trigger: "assistant"` at the
dated-fact boundary, same `source: "agent"`, same atomicity, same refusals — the
per-kind tests were migrated call-for-call and stayed green, which is the evidence
that no behaviour moved. Only the wording of the refusal messages changed, and
they are internal English sentences that no caller and no test reads.

## Consequences

- Adding a kind of proposal is a row plus its params, not a method plus its
  boilerplate. `host.ts` drops from 893 to 218 lines and is again what it claims
  to be: where seams are assembled.
- The gate is testable on its own, without the engine: the refusals, the
  «applied once» promise, and the no-identity-leak invariant are asserted against
  stub seams in `assistant-proposal-apply.test.ts`, plus a `test.each` over every
  row so a kind that forgets the ceremony cannot exist.
- Four dead `applyAssistant*ProposalAndRipple` declarations were deleted from
  `store-types.ts`; `WorthlineStore` already excluded them, so nothing
  implemented them.
- Three kinds stay OUT of the table on purpose: `holding_creation`,
  `holding_removal` and `holding_restoration` resolve their draft from the web
  action, outside a transaction that also carries the write. That asymmetry is
  preexisting and is now visible — the table's comment names it. Bringing them in
  would change their behaviour, which this decision does not do.
- The gate is a dispatcher and nothing more. It does not validate, it does not
  preview, it does not decide: the preview-then-confirm ceremony still lives in
  the web action, which re-projects against live data before calling this.
