"use client";

import { useChat } from "@ai-sdk/react";
import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard-messages";
import { PremiumNotice } from "@web/entitlements/premium-notice";
import type { UIMessage } from "ai";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractEmbeddedQuickActions,
  parseQuickActions,
  type QuickAction,
} from "./assistant-actions";
import AssistantAttachmentControl, {
  ASSISTANT_ATTACHMENT_ACCEPT,
} from "./assistant-attachment-control";
import { assistantChatTransport } from "./assistant-chat-transport";
import { assistantErrorMessage } from "./assistant-error-message";
import { AssistantTextPart } from "./assistant-markdown";
import AssistantMessages from "./assistant-messages";
import { assistantPendingLabel } from "./assistant-pending";
import { parseAttachmentPreviewCard } from "./attachment-chat";
import AttachmentExtractionPreview from "./attachment-extraction-preview";
import { userTurnText } from "./attachment-notice";
import {
  FABRICATED_ALERT_NOTE,
  messagesWithFabricatedMaintainerAlert,
} from "./fabricated-maintainer-alert";
import {
  fabricatedProposalNote,
  messagesWithFabricatedProposal,
} from "./fabricated-proposal";
import { labelsByPublicHoldingId } from "./holding-id-prose";
import { ProposalAppliedContext } from "./onboarding-completion";
import { parsePaywallPartData } from "./paywall-part";
import { proposalCardFor } from "./proposal-cards";
import {
  hasUnvalidatedProvenance,
  UNVALIDATED_PROVENANCE_LABEL,
  UNVALIDATED_PROVENANCE_NOTE,
} from "./proposal-provenance";
import { mergeQuickActions, splitProseActionBlock } from "./prose-actions";
import QuickActionChips from "./quick-action-chips";
import { withoutRepeatedProse } from "./repeated-prose";
import {
  deriveScreenContext,
  isAssistantSurface,
  isOnboardingSurface,
  ONBOARDING_RERUN_PARAM,
  type ScreenSection,
} from "./screen-context";
import { suggestedPrompts } from "./suggested-prompts";
import {
  UNREADABLE_TYPED_SERIES_NOTE,
  UNVALIDATED_EVIDENCE_NOTE,
  unvalidatedEvidenceNotices,
} from "./unvalidated-evidence-notice";

/** Human-readable section names for screen-reader context announcements (#633). */
const SECTION_LABEL: Record<ScreenSection, string> = {
  resumen: "Resumen",
  patrimonio: "Patrimonio",
  historico: "Histórico",
  objetivos: "Objetivos",
  ajustes: "Ajustes",
  otra: "worthline",
};

/**
 * The opening turn seeded when the panel is entered in onboarding re-run mode
 * (PRD #1167 S3, #1170) from the /patrimonio shortcut. The `repasar` flag in the
 * URL puts the assistant in the reconcile-first onboarding mode (system prompt),
 * and this first user turn kicks off the flow so the panel is not a silent box.
 */
const ONBOARDING_RERUN_SEED =
  "Quiero repasar mi cartera y ponerla al día con un extracto o documento nuevo.";

/** The `suggest_actions` output of ONE message, re-validated client-side. */
function toolQuickActions(message: UIMessage): QuickAction[] {
  let actions: QuickAction[] = [];
  for (const part of message.parts) {
    if (part.type === "tool-suggest_actions" && "output" in part) {
      actions = parseQuickActions((part.output as { actions?: unknown } | null)?.actions);
    }
  }
  return actions;
}

/**
 * The prose of one text part with both duplicate action channels removed, and the
 * chips recovered from them: the trailing `{"actions":[…]}` JSON some turns print
 * instead of calling the tool, and the «Acciones recomendadas:» markdown list the
 * model writes ALONGSIDE the tool call. `toolActions` are that same message's
 * chips, which is how a bullet repeating one of them resolves to it.
 */
function proseAndActions(
  text: string,
  toolActions: readonly QuickAction[],
): { cleaned: string; prose: QuickAction[]; embedded: QuickAction[] } {
  const embedded = extractEmbeddedQuickActions(text);
  const prose = splitProseActionBlock(embedded.cleaned, toolActions);
  return { cleaned: prose.cleaned, prose: prose.actions, embedded: embedded.actions };
}

/**
 * The prose to print for each text part of ONE turn, by part index.
 *
 * Two trims, in the order the reader's eye needs them: each part loses its duplicate
 * action channels, and then the TURN loses the blocks it wrote twice (#1317) — a
 * proposal turn restates its whole summary in the step the SDK opens after
 * `suggest_actions`. De-duplicating the CLEANED text is what makes the two agree: an
 * action block trimmed off one copy must not be what stops it from matching the other.
 *
 * Assistant turns only. The user's own words are never reinterpreted (#1047), and a
 * person who repeats themselves is not a defect to correct.
 */
function printableProseByPart(
  message: UIMessage,
  toolActions: readonly QuickAction[],
): Map<number, string> {
  const indices: number[] = [];
  const cleaned: string[] = [];
  message.parts.forEach((part, index) => {
    if (part.type !== "text") return;
    indices.push(index);
    cleaned.push(proseAndActions(part.text, toolActions).cleaned);
  });
  const printable =
    message.role === "assistant" ? withoutRepeatedProse(cleaned) : cleaned;
  return new Map(indices.map((index, at) => [index, printable[at] ?? ""]));
}

/**
 * The typed quick actions the model proposed on the CURRENT turn (#631, ADR
 * 0053): the newest assistant message's `suggest_actions` output, re-validated
 * client-side so only the internal-only typed set ever renders. Older turns'
 * chips fall away as the conversation moves on.
 *
 * The prose block goes FIRST in the merge: those are the follow-ups in the order
 * the reader just read them, and the ones they repeat collapse onto the tool's own
 * chips rather than showing twice.
 */
function currentQuickActions(messages: UIMessage[]): QuickAction[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;

    const toolActions = toolQuickActions(message);
    let prose: QuickAction[] = [];
    let embedded: QuickAction[] = [];

    for (const part of message.parts) {
      if (part.type === "text" && typeof part.text === "string") {
        ({ prose, embedded } = proseAndActions(part.text, toolActions));
      }
    }

    // The embedded JSON stays what it always was — a fallback for the turn that
    // printed its actions instead of calling the tool, never an addition to them.
    const fromText = prose.length > 0 ? prose : toolActions.length > 0 ? [] : embedded;
    return mergeQuickActions(fromText, toolActions);
  }
  return [];
}

/**
 * The app speaking for itself, next to a turn (#1262, #1418).
 *
 * Every one of these says something the model was trusted to relay and did not, so they
 * are set apart the way a proposal is — a paper entry opened by a heavy rule (canon §4)
 * — and labelled in words, never by colour alone (canon §6: oro = aviso). The class is a
 * parameter because the canon guardian looks each entry up by its exact selector, so
 * every note keeps its own rule in `globals.css`.
 */
function AppNote({ className, text }: { className: string; text: string }) {
  return (
    <div className={className} role="note">
      <p className="assistantWarning">
        <strong>Aviso de worthline.</strong> {text}
      </p>
    </div>
  );
}

/**
 * A proposal card, and the provenance mark above it when the server stamped the
 * turn it was born in (#1257).
 *
 * Marked, the two become ONE paper entry: the wrapper takes over the heavy rule
 * that opens a proposal (canon §4) so the stamp reads as the entry's first printed
 * line — above the bold headline the model writes, where it cannot be pushed off the
 * screen. Labelled in words, never by colour alone (canon §6: oro = aviso).
 *
 * Unmarked — the ordinary conversation — it renders the card and nothing else.
 */
function ProposalEntry({
  children,
  marked,
}: {
  children: React.ReactNode;
  marked: boolean;
}) {
  if (!marked) return children;
  return (
    <div className="assistantProposalOrigin">
      {/* `note`, like the app's other aside about a proposal (#1262): it is worthline
          speaking beside the card, not part of the model's turn. */}
      <p className="assistantWarning" role="note">
        <strong>{UNVALIDATED_PROVENANCE_LABEL}.</strong> {UNVALIDATED_PROVENANCE_NOTE}
      </p>
      {children}
    </div>
  );
}

/**
 * The rendered conversation turns — message parts and the proposal cards they
 * unfold into. Extracted so the floating panel (#628) and the full-screen
 * onboarding surface (#1168) render the SAME turns with zero duplication: every
 * proposal the assistant learns to make surfaces in onboarding for free.
 */
function ConversationParts({
  messages,
  error,
  mutationsDisabled,
  mutationsDisabledMessage,
  endRef,
  busy,
  pendingLabel,
}: {
  messages: UIMessage[];
  error: Error | undefined;
  mutationsDisabled: boolean;
  mutationsDisabledMessage: string;
  endRef: React.RefObject<HTMLDivElement | null>;
  busy: boolean;
  pendingLabel: string | null;
}) {
  // Memoised because the panel re-renders on every keystroke in the composer, and
  // this reads every text part of every turn.
  const fabricated = useMemo(
    () => messagesWithFabricatedProposal(messages, busy),
    [messages, busy],
  );
  // The turns that said they filed an incident and did not (#1525). Painted here and
  // not only fed back into history because this lie has NO empty card to give it away:
  // an alert renders nothing ever, so without this the user finds out by asking for a
  // ticket number, which is exactly how the incident was discovered.
  const fabricatedAlerts = useMemo(
    () => messagesWithFabricatedMaintainerAlert(messages, busy),
    [messages, busy],
  );
  // The holding names this conversation read, so the assistant's prose can name a
  // holding where it wrote its id (#1263). Memoised for the same reason: the panel
  // re-renders on every keystroke and this walks every tool output of every turn.
  const holdingLabels = useMemo(() => labelsByPublicHoldingId(messages), [messages]);
  // The two turns that carry the gate's notes (#1418) — one each per conversation, so
  // both are decided over the whole thread and not per message.
  const gateNotices = useMemo(() => unvalidatedEvidenceNotices(messages), [messages]);
  return (
    <>
      {messages.map((message) => {
        // This turn's own chips, so a repeated bullet in its prose resolves to the
        // chip it was describing instead of blocking the trim of the whole block.
        const messageActions =
          message.role === "assistant" ? toolQuickActions(message) : [];
        const prose = printableProseByPart(message, messageActions);
        // Which ceremony this turn faked, if any — it decides WHICH sentence the app
        // puts next to it (#1468).
        const fabrication = fabricated.get(message.id);
        return (
          <div className={`assistantMsg ${message.role}`} key={message.id}>
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                const text = prose.get(i) ?? "";
                // Nothing left to print: the part was a repeat, or was entirely the
                // action block that became chips.
                if (text.trim() === "") return null;
                return (
                  <AssistantTextPart
                    holdingLabels={holdingLabels}
                    key={`${message.id}-${i}`}
                    role={message.role}
                    text={text}
                  />
                );
              }
              if (part.type === "data-attachment-extraction") {
                // Never `null` for a payload with anything paintable in it: a card
                // from a newer server degrades rather than disappearing (#1261).
                const card = parseAttachmentPreviewCard(part.data);
                return card ? (
                  <AttachmentExtractionPreview card={card} key={`${message.id}-${i}`} />
                ) : null;
              }
              if (part.type === "data-paywall") {
                const paywall = parsePaywallPartData(part.data);
                return paywall ? (
                  <PremiumNotice key={`${message.id}-${i}`} message={paywall.message} />
                ) : null;
              }
              if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                const name =
                  "toolName" in part ? String(part.toolName) : part.type.slice(5);
                // suggest_actions renders as chips below, not as tool activity.
                if (name === "suggest_actions") return null;
                const card = proposalCardFor({
                  mutationsDisabled,
                  mutationsDisabledMessage,
                  part,
                });
                if (card === null) return null;
                // The provenance mark (#1257) is read off the server's own tool output,
                // by key — never from the prose the model wrote on the card.
                return (
                  <ProposalEntry
                    key={`${message.id}-${i}`}
                    marked={"output" in part && hasUnvalidatedProvenance(part.output)}
                  >
                    {card}
                  </ProposalEntry>
                );
              }
              return null;
            })}
            {fabrication === undefined ? null : (
              <AppNote
                className="assistantFakeProposal"
                // Same entry, two sentences (#1468): «nunca la pidió» and «la pidió y
                // worthline no devolvió tarjeta» leave the user with different moves.
                text={fabricatedProposalNote(fabrication)}
              />
            )}
            {fabricatedAlerts.has(message.id) ? (
              <AppNote className="assistantFakeAlert" text={FABRICATED_ALERT_NOTE} />
            ) : null}
            {gateNotices.gateClosed === message.id ? (
              <AppNote className="assistantGateNotice" text={UNVALIDATED_EVIDENCE_NOTE} />
            ) : null}
            {gateNotices.unreadableSeries === message.id ? (
              <AppNote
                className="assistantSeriesNotice"
                text={UNREADABLE_TYPED_SERIES_NOTE}
              />
            ) : null}
          </div>
        );
      })}
      {pendingLabel === null ? null : <AssistantPendingNotice label={pendingLabel} />}
      {error ? (
        <p className="assistantError" role="alert">
          {assistantErrorMessage(error)}
        </p>
      ) : null}
      <div ref={endRef} />
    </>
  );
}

/**
 * The visible twin of the panel's `srOnly` live region (#1286). `aria-hidden`
 * precisely because that region already announces the same fact: a screen reader
 * must hear «el asistente está respondiendo» once, not twice.
 *
 * Reuses the `.navPending` ring (#607) rather than inventing a second spinner
 * idiom, so a slow turn and a slow navigation read the same way.
 */
function AssistantPendingNotice({ label }: { label: string }) {
  return (
    <p aria-hidden="true" className="assistantPending">
      <span className="navPending" />
      {label}
    </p>
  );
}

/**
 * The message composer: attachment control plus the text input row. Shared by
 * the floating panel and the onboarding surface (#1168).
 */
function Composer({
  busy,
  attachment,
  setAttachment,
  draft,
  setDraft,
  inputRef,
  onSubmit,
  placeholder,
}: {
  busy: boolean;
  attachment: File | null;
  setAttachment: (file: File | null) => void;
  draft: string;
  setDraft: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: (e: React.FormEvent) => void;
  placeholder: string;
}) {
  return (
    <form className="assistantComposer" onSubmit={onSubmit}>
      <AssistantAttachmentControl
        disabled={busy}
        file={attachment}
        onChange={setAttachment}
        onRemove={() => setAttachment(null)}
      />
      <div className="assistantInputRow">
        <input
          aria-label="Mensaje para el asistente"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          ref={inputRef}
          value={draft}
        />
        <button
          disabled={busy || (draft.trim() === "" && attachment === null)}
          type="submit"
        >
          Enviar
        </button>
      </div>
    </form>
  );
}

/**
 * The financial assistant's contextual layer (#629, container decided in S0
 * #628): a FAB opens an overlay side panel (desktop) / bottom sheet (mobile)
 * that survives in-app navigation because it mounts in the root layout. The
 * conversation is ephemeral — client state only, nothing persisted (#627).
 *
 * On the dedicated onboarding route (#1168) the SAME layer renders a full-screen
 * «estreno» presentation instead — a dominant drop-zone, a welcome first turn,
 * and two deliberately discreet escapes («a mano» / «lo haré luego»). It reuses
 * the conversation and composer above, so anything the assistant learns to
 * propose enriches onboarding for free (the whole point of «cero motor nuevo»).
 *
 * Styles live in globals.css (`assistant*` / `onboarding*` classes, tokens).
 */

export default function AssistantLayer({
  mutationsDisabled = false,
  mutationsDisabledMessage = DEMO_DISABLED_MESSAGE,
  variant = "floating",
  initialOpen = false,
  onboardingManualHref = "/patrimonio/anadir",
  onboardingSkipAction,
  onboardingCompleteAction,
}: {
  mutationsDisabled?: boolean;
  mutationsDisabledMessage?: string;
  variant?: "floating" | "onboarding";
  /**
   * Whether the floating panel opens on mount. The lazy launcher (#1192) passes
   * this `true` when the panel is opened for the first time, so the heavy layer
   * chunk — which only loads on that first open — comes up already showing the
   * panel instead of its FAB. Once mounted, the layer owns its open/close state
   * as before (the launcher hands over completely).
   */
  initialOpen?: boolean;
  onboardingManualHref?: string;
  onboardingSkipAction?: (formData: FormData) => void | Promise<void>;
  onboardingCompleteAction?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const { messages, sendMessage, status, error } = useChat({
    transport: assistantChatTransport,
  });
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rerunRequested = searchParams.get(ONBOARDING_RERUN_PARAM) === "1";
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  // Set the instant BEFORE we close so focus returns to the trigger, not the
  // top of the page — but never steals focus on first mount (#633, a11y).
  const closingRef = useRef(false);

  const busy = status === "submitted" || status === "streaming";
  // Computed once for both surfaces: the floating panel and the onboarding screen
  // must not disagree about whether a turn is in flight (#1286).
  const pendingLabel = assistantPendingLabel({ messages, status });
  const quickActions = currentQuickActions(messages);
  // Prompts depend only on the section, which comes from the pathname; recomputed
  // on every navigation so the starter set matches the surface underneath (#632).
  const section = deriveScreenContext(pathname, "").section;
  const prompts = suggestedPrompts({
    route: pathname,
    section,
    holdingId: null,
    view: {},
  });

  const close = useCallback(() => {
    closingRef.current = true;
    setOpen(false);
  }, []);

  // Stamp `onboarded_at` on the first confirmed proposal (#1169). Guarded to fire
  // the set-once mark at most once per session, even if several cards apply; the
  // server action is itself idempotent (COALESCE), so this is belt-and-braces.
  const onboardedRef = useRef(false);
  const handleProposalApplied = useCallback(() => {
    if (onboardedRef.current || !onboardingCompleteAction) return;
    onboardedRef.current = true;
    void onboardingCompleteAction();
  }, [onboardingCompleteAction]);

  function seed(text: string) {
    if (busy) return;
    void sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (closingRef.current) {
      fabRef.current?.focus();
      closingRef.current = false;
    }
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows or settles
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, status, error]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, open]);

  useEffect(() => {
    if (!isAssistantSurface(pathname) && open) setOpen(false);
  }, [open, pathname]);

  // Re-run onboarding entry (#1170): the /patrimonio shortcut navigates here with
  // `?repasar=1`, which puts the turn in the reconcile-first onboarding mode (the
  // system prompt derives it from the flag in the screen context). Open the panel
  // and, on a fresh conversation, seed the opening turn so it is not a silent box.
  // The flag is a ONE-SHOT activation: once consumed we strip it from the URL so
  // the re-run framing does not stick to every later /patrimonio turn. Since the
  // transport reads `window.location` directly, this takes effect on the next
  // turn. Never in the onboarding variant — the /bienvenida estreno surface owns
  // its own full-screen entry.
  const rerunConsumedRef = useRef(false);
  useEffect(() => {
    if (variant !== "floating" || !rerunRequested || rerunConsumedRef.current) return;
    rerunConsumedRef.current = true;
    setOpen(true);
    if (messages.length === 0) {
      void sendMessage({
        role: "user",
        parts: [{ type: "text", text: ONBOARDING_RERUN_SEED }],
      });
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(ONBOARDING_RERUN_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [rerunRequested, variant, messages.length, sendMessage]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if ((text === "" && attachment === null) || busy) return;
    const selectedAttachment = attachment;
    void sendMessage(
      {
        role: "user",
        parts: [
          { type: "text", text: userTurnText(text, selectedAttachment?.name ?? null) },
        ],
      },
      selectedAttachment ? { body: { attachment: selectedAttachment } } : undefined,
    );
    setDraft("");
    setAttachment(null);
  }

  // The onboarding drop-zone is the hero action (#1168): a dropped document
  // sends straight away, so arriving with a statement in hand needs no typing.
  function sendAttachment(file: File) {
    if (busy) return;
    void sendMessage(
      { role: "user", parts: [{ type: "text", text: userTurnText("", file.name) }] },
      { body: { attachment: file } },
    );
  }

  if (variant === "onboarding") {
    const hasConversation = messages.length > 0;
    return (
      <main aria-label="Bienvenida a worthline" className="onboardingSurface">
        <p aria-live="polite" className="srOnly" role="status">
          {busy
            ? "El asistente está respondiendo."
            : "Onboarding de worthline. Arrastra tus extractos o cuéntame qué tienes."}
        </p>

        <header className="coverSurface coverMasthead onboardingMasthead">
          <p className="empezarEyebrow">Patrimonio neto</p>
          <h1>worthline</h1>
        </header>

        <div className="onboardingBody">
          {hasConversation ? null : (
            <div className="onboardingWelcome">
              <h2>Vamos a componer tu patrimonio.</h2>
              <p>
                Arrastra aquí tus extractos, PDFs o tu Excel —o cuéntame qué tienes— y lo
                convierto en tu patrimonio, contigo, en unos minutos.
              </p>

              <label
                className={`onboardingDrop${dragActive ? " dragging" : ""}`}
                htmlFor="onboarding-drop-input"
                onDragLeave={() => setDragActive(false)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) sendAttachment(file);
                }}
              >
                <span className="onboardingDropTitle">
                  Arrastra un documento o pulsa para elegirlo
                </span>
                <span className="onboardingDropHint">
                  Captura, CSV, XLSX o PDF de tu banco o bróker
                </span>
                <input
                  accept={ASSISTANT_ATTACHMENT_ACCEPT}
                  className="srOnly"
                  disabled={busy}
                  id="onboarding-drop-input"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (file) sendAttachment(file);
                  }}
                  type="file"
                  value=""
                />
              </label>

              {prompts.length > 0 ? (
                <div
                  aria-label="O cuéntamelo por escrito"
                  className="assistantPrompts"
                  role="group"
                >
                  {prompts.map((p) => (
                    <button
                      className="assistantChip"
                      key={p.id}
                      onClick={() => seed(p.prompt)}
                      type="button"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          <AssistantMessages>
            {/* Confirming the first proposal here stamps onboarded (#1169); the
                floating panel provides no listener, so it never fires there. */}
            <ProposalAppliedContext.Provider value={handleProposalApplied}>
              <ConversationParts
                endRef={endRef}
                error={error}
                messages={messages}
                mutationsDisabled={mutationsDisabled}
                mutationsDisabledMessage={mutationsDisabledMessage}
                busy={busy}
                pendingLabel={pendingLabel}
              />
            </ProposalAppliedContext.Provider>
          </AssistantMessages>

          <QuickActionChips actions={quickActions} onRun={seed} />

          <Composer
            attachment={attachment}
            busy={busy}
            draft={draft}
            inputRef={inputRef}
            onSubmit={submit}
            placeholder="Cuéntame qué tienes…"
            setAttachment={setAttachment}
            setDraft={setDraft}
          />

          {/* Escapes deliberadamente discretos (#1130): a mano y «lo haré luego».
              Nunca un «plan B» ruidoso; siempre accesibles. */}
          <nav aria-label="Otras formas de empezar" className="onboardingEscapes">
            <Link href={onboardingManualHref}>Prefiero cargarlo a mano</Link>
            {onboardingSkipAction ? (
              <form action={onboardingSkipAction}>
                <button type="submit">Lo haré luego</button>
              </form>
            ) : (
              <Link href="/app">Lo haré luego</Link>
            )}
          </nav>
        </div>
      </main>
    );
  }

  // The floating layer never shows on the onboarding route — that surface is the
  // onboarding variant above, mounted by the route itself.
  if (!isAssistantSurface(pathname) || isOnboardingSurface(pathname)) {
    return null;
  }

  if (!open) {
    return (
      <button
        aria-label="Abrir asistente"
        className="assistantFab"
        onClick={() => setOpen(true)}
        ref={fabRef}
        type="button"
      >
        ✳
      </button>
    );
  }

  return (
    <section aria-label="Asistente financiero" className="assistantPanel" role="dialog">
      {/* Polite live region: announces streaming and the current screen context
          so the layer is not a silent state change for screen readers (#633). */}
      <p aria-live="polite" className="srOnly" role="status">
        {busy
          ? "El asistente está respondiendo."
          : `Asistente abierto sobre ${SECTION_LABEL[section]}.`}
      </p>

      <header className="assistantHead">
        <h2>Asistente</h2>
        <button aria-label="Cerrar asistente" onClick={close} type="button">
          ×
        </button>
      </header>

      <AssistantMessages>
        {messages.length === 0 ? (
          <div className="assistantHint">
            <p>Pregunta sobre tu patrimonio: cifras, deudas, liquidez, exposición…</p>
            <div
              aria-label="Preguntas sugeridas"
              className="assistantPrompts"
              role="group"
            >
              {prompts.map((p) => (
                <button
                  className="assistantChip"
                  key={p.id}
                  onClick={() => seed(p.prompt)}
                  type="button"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <ConversationParts
          endRef={endRef}
          error={error}
          messages={messages}
          mutationsDisabled={mutationsDisabled}
          mutationsDisabledMessage={mutationsDisabledMessage}
          busy={busy}
          pendingLabel={pendingLabel}
        />
      </AssistantMessages>

      <QuickActionChips actions={quickActions} onRun={seed} />

      <Composer
        attachment={attachment}
        busy={busy}
        draft={draft}
        inputRef={inputRef}
        onSubmit={submit}
        placeholder="Pregunta sobre esta pantalla…"
        setAttachment={setAttachment}
        setDraft={setDraft}
      />
    </section>
  );
}
