# Assistant proposals preview, then confirm

Assistant proposals are a separate action class from read-only quick actions. A proposal tool may draft a workspace change, but the tool itself receives only read ports and writes nothing. The app renders the tool output as a before/after preview in the chat layer; reject drops the preview, and confirm sends the draft to a server action.

The server action is the trust boundary. It re-parses the draft, rejects malformed buckets or over-100 exposure breakdowns, verifies the key still resolves to a hand-entry-eligible holding, stamps accepted rows with `source: agent` and `declaredAt`, and then writes through the same persistence seam as manual entry. Demo confirms return a read-only note and do not open the store for mutation.

The first implementation is `propose_exposure_profiles`: a batch of exposure-profile drafts keyed by ISIN or provider symbol. Omitted fields preserve existing profile data, while explicit `null` clears a field, matching the existing exposure-profile upsert semantics. Future assistant-created imports or fixes should reuse this preview/confirm shape instead of adding direct model writes.

**Amendment (#1014):** exposure-profile proposals were retired. Profile authoring is admin-only (ADR 0058); remaining proposal types (statement import, balance history, property valuation, mixed document) keep this preview/confirm shape.
