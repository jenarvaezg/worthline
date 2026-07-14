# Attachments use a dedicated eager extractor

The conversational provider pool is designed for fungible reasoning over text and
trusted workspace facts. Broker screenshots and spreadsheets need a different
boundary: interpreting them is input processing, and a plausible but malformed or
partial extraction must never become conversational context. Letting whichever chat
model is active inspect a file would also make attachment behaviour depend on pool
failover and would give the model discretion over whether to extract at all.

Financial attachments carry more sensitive data than their structured result. The
product needs the positions for the current conversation, not a durable copy of the
source binary. Any path from an attachment to a workspace mutation must preserve the
existing preview-and-confirm trust boundary.

## Decision

Attachments are processed through a dedicated extractor seam outside the
conversational provider pool. Screenshot extraction uses one reviewed vision model,
fixed by application code and overridable only through the extractor-specific
configuration. Spreadsheet extraction is deterministic. Both routes produce the same
versioned positions contract and the same typed outcomes: valid, unrecognized,
out-of-limits, or extractor failure. Failures distinguish transient conditions from
definitive ones.

The contract is the validation boundary. Symbol and name remain separate; units,
market value in EUR, source currency, optional total, uncertainty, and warnings are
explicit. Type, byte-size, and row limits live with that contract. Malformed or partial
extractor output is converted to a definitive failure and cannot be forwarded as if it
were a valid extraction. The deployed request limit is 4 MiB: Vercel Functions reject
bodies above 4.5 MB before application code runs, so the product limit leaves room for
multipart framing and the accompanying text instead of exposing an opaque platform 413.

The v1 extraction JSON deliberately carries units and EUR values as numbers in major
units, matching the external extractor schema decided in #865. This is transport context,
not a persisted domain representation. Any later import or wizard bridge must convert
money to integer minor units and quantities to decimal strings before they cross into the
worthline domain, preserving the product-wide representation constraint.

Extraction is eager and pre-stream. The chat route completes extraction before asking
the conversational model for a response, then supplies only the validated structured
result as user-turn context. No pool model decides whether to inspect the attachment,
and provider failover continues to operate on the same text-and-structured-context
input.

The UI must render a preview of the validated result, including uncertainty and
warnings, before offering any route toward persistence. Chat and extractor code receive
no workspace write capability. A later import or wizard flow may accept the preview as
input, but its existing explicit confirmation boundary remains responsible for any
write.

The source binary lives only for the duration of extraction. It is processed and then
discarded: no blob, file, or document copy is persisted. Conversation history may keep
the validated structured extraction so later turns retain the facts that were actually
shown to the user.

## Considered options

- **Let the active conversational model read attachments** — rejected. Pool members do
  not share vision or spreadsheet guarantees, failover would change interpretation,
  and extraction would become a model-selected action.
- **Expose extraction as a conversational tool** — rejected. The model could omit or
  delay the call, so an unvalidated attachment could influence a response before the
  extraction boundary had run.
- **Persist the source file for later reprocessing** — rejected. The v1 use case needs
  structured conversational context, and keeping financial binaries adds a sensitive
  storage lifecycle without a product requirement.
- **Write extracted positions directly from chat** — rejected. Extraction is evidence
  for a preview, not user confirmation; writes stay in the existing import and wizard
  flows.

## Consequences

- Screenshot and spreadsheet implementations can evolve independently while callers
  consume one honest, validated result contract.
- Attachment latency is paid before streaming starts, but every conversational provider
  receives the same extraction and no malformed output reaches it silently.
- Retry and user messaging can branch on typed failure and limit reasons without parsing
  provider errors.
- The product can retain useful structured conversation history without retaining the
  more sensitive binary source.
- Future import bridges and previews must preserve explicit confirmation and cannot add
  a chat-side write shortcut.
