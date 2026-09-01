/**
 * Which providers may be tried, what each of them gets to read, and what a rejection
 * costs them (#1697, extracted from `route.ts`).
 *
 * Three phases that all answer to the same fact: since #1408 there is ONE prompt PER
 * PROVIDER, so «the turn» is not a single object the route can build once.
 */

import {
  type AttachmentPreviewData,
  prepareAttachmentMessagesForModel,
} from "@web/asistente/attachment-chat";
import type { UnstructuredReading } from "@web/asistente/attachment-turn";
import type { createChatTools } from "@web/asistente/chat-tools";
import { fitHistoryToBudget } from "@web/asistente/history-prose-budget";
import {
  deriveProviderCooldownUntil,
  providersOutsideCooldown,
} from "@web/asistente/provider-cooldown";
import {
  readProviderCooldowns,
  recordProviderCooldown,
} from "@web/asistente/provider-cooldown-store";
import type { ProviderRejection } from "@web/asistente/provider-failover";
import type { ResolvedProviderModel } from "@web/asistente/provider-model";
import { turnPromptBudget } from "@web/asistente/turn-prompt-budget";
import { convertToModelMessages, type UIMessage } from "ai";

import { operationalCause } from "./chat-responses";

export interface PreparedTurn {
  messages: Awaited<ReturnType<typeof convertToModelMessages>>;
  tools: ReturnType<typeof createChatTools>;
}

/**
 * The providers this instance may try right now.
 *
 * A cooldown observed from ANOTHER instance still counts (#1300): the pool is shared,
 * so the state lives in the control plane. A failed read is logged and ignored — a
 * meter that is down must not take the assistant down with it — and the `local` mode
 * deliberately narrows to the first credential, keeping a single-user dev box
 * stateless.
 */
export async function eligibleProvidersFor(
  providers: readonly ResolvedProviderModel[],
): Promise<readonly ResolvedProviderModel[]> {
  try {
    const cooldownState = await readProviderCooldowns();
    return cooldownState.mode === "local"
      ? providers.slice(0, 1)
      : providersOutsideCooldown(providers, cooldownState.cooldowns);
  } catch (error) {
    console.error("Assistant provider cooldown read failed", {
      operation: "read",
      cause: operationalCause(error),
    });
    return providers;
  }
}

/**
 * ONE prompt PER PROVIDER (#1408). The history is fitted to the budget of the model
 * that is about to read it, so `gemini-3.1-flash-lite` — 1 048 576 input tokens —
 * keeps a whole conversation where a 30 000-tokens-per-minute fallback gets a cut
 * one. Before this, both were held to a single 16 000-character ceiling that
 * REFUSED, and one recited document ended the conversation for good.
 *
 * The tools are rebuilt per provider too, and that is not incidental: the write
 * gates take their allowlists from the history the model can see (#1263, #1373),
 * so deriving them once from the unfitted history would let them name a document
 * that this provider was never handed.
 *
 * An empty map means the SDK could not convert the history for ANY provider, which is
 * the caller's cue to take the unreachable-model exit.
 */
export async function prepareTurnPerProvider(input: {
  buildTools: (history: UIMessage[]) => ReturnType<typeof createChatTools>;
  messages: UIMessage[];
  preview: AttachmentPreviewData | null;
  providers: readonly ResolvedProviderModel[];
  unstructured: UnstructuredReading | null;
}): Promise<Map<string, PreparedTurn>> {
  const { buildTools, messages, preview, providers, unstructured } = input;
  const prepared = new Map<string, PreparedTurn>();
  for (const provider of providers) {
    const budget = turnPromptBudget(provider);
    const fitted = fitHistoryToBudget(messages, budget);
    if (
      fitted.droppedMessageIds.length > 0 ||
      fitted.droppedAttachmentCards > 0 ||
      fitted.truncatedMessageIds.length > 0
    ) {
      // Silent to the user by design (#1408), never silent to us: this is how often a
      // real conversation outgrows a real model, and the refusal it replaces made that
      // frequency unmeasurable — every one of them ended in a reload.
      console.info("Assistant history fitted to the model budget", {
        provider: provider.provider,
        modelId: provider.modelId,
        droppedMessages: fitted.droppedMessageIds.length,
        droppedAttachmentCards: fitted.droppedAttachmentCards,
        truncatedMessages: fitted.truncatedMessageIds.length,
      });
    }
    try {
      prepared.set(provider.provider, {
        messages: await convertToModelMessages(
          prepareAttachmentMessagesForModel(
            fitted.messages,
            preview,
            // The reading, not the already-fitted block: remaining budget after the
            // typed cards is computed inside, so a historical series and this turn's
            // notebook share one ceiling instead of stacking (#1492, #1419).
            unstructured ?? null,
            budget.attachmentChars,
          ),
        ),
        tools: buildTools(fitted.messages),
      });
    } catch {
      // A history the SDK cannot convert is unconvertible for every provider, so
      // this leaves the map empty and takes the caller's exit.
    }
  }
  return prepared;
}

/** Put a provider that rejected the turn on cooldown, when its rejection earns one. */
export async function recordProviderRejection(
  rejection: ProviderRejection<ResolvedProviderModel>,
): Promise<void> {
  const { provider, classification, error } = rejection;
  const cooldownUntil = deriveProviderCooldownUntil(error, classification);
  if (cooldownUntil === null) return;
  try {
    const persisted = await recordProviderCooldown(provider.provider, cooldownUntil);
    if (persisted) {
      console.info("Assistant provider cooldown recorded", {
        provider: provider.provider,
        modelId: provider.modelId,
        classification,
        cooldownUntil: cooldownUntil.toISOString(),
      });
    }
  } catch (storageError) {
    console.error("Assistant provider cooldown write failed", {
      operation: "write",
      provider: provider.provider,
      classification,
      cause: operationalCause(storageError),
    });
  }
}
