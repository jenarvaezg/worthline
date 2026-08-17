/**
 * How one turn's prompt is divided up, PER MODEL (#1408).
 *
 * Before this module there were four ceilings that never looked at each other, and
 * the smallest of them — 16 000 characters for the whole conversation's prose —
 * was neither measured nor derived from anything. It was also the only one that
 * REFUSED instead of shrinking, so describing a 425-row amortisation table (#1405)
 * ended the conversation for good: the browser re-sends the same history every
 * turn, so its 400 repeats identically forever.
 *
 * Two things were wrong, and they are different things:
 *
 * 1. **The mode of failure.** Any finite ceiling is a cliff if reaching it means a
 *    permanent refusal. History is SHRUNK now (`history-prose-budget.ts`), the way
 *    #1260 already did it for tool payloads.
 * 2. **The number.** A single ceiling for the whole pool has to be the narrowest
 *    member's, so `gemini-3.1-flash-lite` — which accepts 1 048 576 input tokens —
 *    was being held to a budget sized for the free tier of a fallback. That is what
 *    "per model" fixes: the budget is derived from the model's own capacity, and the
 *    conversation is fitted to it when the turn is built, once the provider is known.
 *
 * Measured in characters, like the turn floor and for the same reason: each provider
 * tokenizes with its own BPE, so a token count computed here would be an estimate
 * dressed as a measurement. {@link CHARS_PER_TOKEN} converts the providers' published
 * token capacity into this module's unit, deliberately pessimistically.
 */

import { TURN_FLOOR_CHAR_CEILING } from "./turn-floor";

/**
 * Read tool(s) + answer + suggest_actions (#631), with headroom for one extra read.
 *
 * It belongs next to the budget because it MULTIPLIES it: every step re-sends the
 * whole prompt, so a per-minute token allowance buys `1 / MAX_STEPS` of itself per
 * request. Cerebras' free tier is the case that makes this visible.
 */
export const MAX_STEPS = 6;

/**
 * Characters assumed per token when converting a published capacity into this
 * module's unit, and deliberately pessimistic. Measured, not guessed: `eval:floor`
 * on 2026-07-30 read the same bare turn of 35 390 characters as 9 231 input tokens
 * on `gemini-3.1-flash-lite` (3,83 chars/token) and 7 732 on `gpt-oss-120b` (4,58),
 * so charging 3 under-counts what fits in every BPE in the pool. The cost of being
 * wrong in the other direction is a refused request, and a budget is the one thing
 * that must not need luck.
 */
const CHARS_PER_TOKEN = 3;

/**
 * Tool payloads are NOT charged to the prose budget (#1260). They are not the user's
 * text and they dwarf it: ONE `get_snapshot_history` with per-position rows measures
 * 113 773 characters, so charging it to the prose ceiling killed healthy
 * conversations. There is deliberately no ceiling that REFUSES them either — that
 * refusal is permanent for the same reason. Oversized history is shrunk instead.
 */
const MAX_TOOL_PROMPT_CHARS = 80_000;
/**
 * Room for the freshest reading AND a pending proposal at the same time: measured,
 * `get_snapshot_history` with summary rows is 42 550 characters, so a tighter total
 * meant one of the two had to go — the reading the answer stands on, or the
 * proposal the user is about to confirm.
 */
const MAX_TOOL_PROPOSAL_CHARS = 48_000;
/** What the readings behind the freshest one share before being dropped. */
const MAX_STALE_TOOL_READ_CHARS = 24_000;
/**
 * And how many tool parts may survive at all, because characters alone do not
 * bound the prompt: the SDK expands each kept part into a call AND a result, so
 * 10 000 tiny parts fitted the character budget and still tripled it. Six steps
 * per turn ({@link MAX_STEPS}) means this covers several turns of grounding.
 */
const MAX_TOOL_PARTS_IN_PROMPT = 40;

/**
 * The prose floor: what a provider gets even when its capacity says less. Below a
 * couple of short question-and-answer pairs the assistant cannot hold a dialogue at
 * all, and a provider that narrow is better off REJECTING the request — its 429 is
 * classified and fails over (`provider-failover.ts`) — than being handed an
 * amputated conversation and answering confidently from it.
 */
const MIN_PROSE_CHARS = 8_000;
/**
 * The prose ceiling, and it is a product decision rather than a capacity one: the
 * whole history travels again on every turn, so what limits it is cost and latency,
 * not the window. 200 000 characters is ~5 % of flash-lite's window, 12× what
 * #1408 found, and holds ten recitations the size of the one that closed the
 * conversation in the report.
 */
const MAX_PROSE_CHARS = 200_000;
/** One structured positions card, so an attachment turn is never born starved. */
const MIN_ATTACHMENT_CHARS = 16_000;
/** What attachment history was already allowed to reach before #1408 — now shrunk to, never refused at. */
const MAX_ATTACHMENT_CHARS = 256_000;
/**
 * How the margin left after the floor and the tools is split between the two
 * client-written budgets. Prose is the smaller share because an attachment card is
 * a single structured document the model must read whole, while prose degrades
 * gracefully: dropping the oldest turns costs memory, not comprehension.
 */
const PROSE_SHARE = 0.45;

/**
 * How many messages may reach the provider. A ceiling in characters is not enough
 * on its own — the client writes these — and this one no longer refuses: the
 * oldest turns are dropped down to it. Twenty question-and-answer pairs.
 */
const MAX_MESSAGES = 40;

/** What a provider's own documentation says it will accept. */
export interface ModelPromptCapacity {
  /** Input tokens accepted in ONE request, or null when the provider does not publish it. */
  inputTokens: number | null;
  /** The per-minute allowance, when the tier has one that is tighter than the window. */
  tokensPerMinute: number | null;
  /** Where both numbers come from, so the next reader can re-check them. */
  source: string;
}

/** What one turn's history may carry to one model. */
export interface TurnPromptBudget {
  /** The conversation's own text, tool payloads and attachment cards excluded. */
  proseChars: number;
  /** Attachment preview cards surviving in history. */
  attachmentChars: number;
  /** Messages that may reach the provider at all. */
  maxMessages: number;
}

/**
 * The tool-payload budget of #1260. Deliberately NOT per model: its figures are
 * measured against real readings (a `get_snapshot_history` is what it is whoever
 * answers), the grounding they protect is what the answer stands on, and every
 * model's budget above already charges {@link MAX_TOOL_PROMPT_CHARS} before
 * dividing what is left. Charging it twice would starve the prose instead.
 */
export const TOOL_PROMPT_BUDGET = {
  maxParts: MAX_TOOL_PARTS_IN_PROMPT,
  proposalChars: MAX_TOOL_PROPOSAL_CHARS,
  staleChars: MAX_STALE_TOOL_READ_CHARS,
  totalChars: MAX_TOOL_PROMPT_CHARS,
} as const;

/**
 * The capacity of every model in the pool, keyed as `provider/modelId`.
 *
 * Every figure here is quoted from the provider, never from a model's reputation —
 * and this module's guard test fails if a pool entry has no card, so admitting a
 * model without reading its documentation is not possible.
 */
export const MODEL_PROMPT_CAPACITY: Readonly<Record<string, ModelPromptCapacity>> = {
  /**
   * The primary, and the one that answers virtually every turn. A million input
   * tokens is ~3 000 000 characters at {@link CHARS_PER_TOKEN}, which is why the
   * prose budget lands on its product ceiling rather than on its capacity.
   */
  "google/gemini-3.1-flash-lite": {
    inputTokens: 1_048_576,
    // Google publishes rate limits per account in AI Studio rather than per model,
    // so there is no per-minute figure to charge here.
    tokensPerMinute: null,
    source:
      "ai.google.dev model listing (inputTokenLimit 1 048 576, output 65 536), read 2026-07-10 · docs/research/2026-07-10-vision-gemini-free-extractor.md",
  },
  /**
   * The fallback, and its window is not what binds it: 30 000 tokens per minute
   * against {@link MAX_STEPS} re-sends of the prompt leaves ~5 000 tokens per
   * request, which the turn floor alone already exceeds. So this entry lands on
   * the floors below by arithmetic, not by choice — it is a provider that can
   * serve short turns and will reject the rest, and a rejection here fails over.
   */
  "cerebras/gpt-oss-120b": {
    // Cerebras' rate-limit page does not publish a context window for this model,
    // and an unverified figure has no business in a budget. The per-minute ceiling
    // is narrower than any plausible window anyway, so nothing is lost by it.
    inputTokens: null,
    tokensPerMinute: 30_000,
    source:
      "inference-docs.cerebras.ai/support/rate-limits (Free Trial: 5 RPM · 30 K TPM · 1 M TPH · 1 M TPD), re-read 2026-08-17",
  },
};

function capacityKey(model: { provider: string; modelId: string }): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * The card for a model, falling back to any card of the SAME provider.
 *
 * The fallback matters: a version bump on the primary (`gemini-3.1-flash-lite` →
 * whatever succeeds it) would otherwise drop the budget to the floors silently, and
 * the symptom would be an assistant that quietly forgets attachments — the exact
 * class of failure #1408 is about. Capacity is a property of the account and the
 * tier as much as of the weights, so a sibling's card is a far better guess than
 * the floor. A provider with no card at all does get the floor.
 */
function capacityFor(model: {
  provider: string;
  modelId: string;
}): ModelPromptCapacity | undefined {
  const exact = MODEL_PROMPT_CAPACITY[capacityKey(model)];
  if (exact !== undefined) return exact;
  const prefix = `${model.provider}/`;
  const sibling = Object.entries(MODEL_PROMPT_CAPACITY).find(([key]) =>
    key.startsWith(prefix),
  );
  return sibling?.[1];
}

/** What one request may carry to this model, in characters, floors aside. */
function perRequestChars(capacity: ModelPromptCapacity): number {
  const perMinute =
    capacity.tokensPerMinute === null
      ? null
      : Math.floor(capacity.tokensPerMinute / MAX_STEPS);
  const tokens =
    capacity.inputTokens === null
      ? perMinute
      : perMinute === null
        ? capacity.inputTokens
        : Math.min(capacity.inputTokens, perMinute);
  return tokens === null ? 0 : tokens * CHARS_PER_TOKEN;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.floor(value), low), high);
}

/**
 * The budget for a model, derived from its capacity card (or a sibling's — see
 * {@link capacityFor}). An unknown PROVIDER gets the floors: a turn that is too
 * small still answers, where one that is too big is refused, and the guard test
 * makes the case unreachable for anything in the production pool.
 */
export function turnPromptBudget(model: {
  provider: string;
  modelId: string;
}): TurnPromptBudget {
  const capacity = capacityFor(model);
  const available =
    capacity === undefined
      ? 0
      : Math.max(
          0,
          perRequestChars(capacity) - TURN_FLOOR_CHAR_CEILING - MAX_TOOL_PROMPT_CHARS,
        );
  return {
    proseChars: clamp(available * PROSE_SHARE, MIN_PROSE_CHARS, MAX_PROSE_CHARS),
    attachmentChars: clamp(
      available * (1 - PROSE_SHARE),
      MIN_ATTACHMENT_CHARS,
      MAX_ATTACHMENT_CHARS,
    ),
    maxMessages: MAX_MESSAGES,
  };
}
