"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { parseQuickActions, type QuickAction } from "./assistant-actions";
import { deriveScreenContext, type ScreenSection } from "./screen-context";
import { suggestedPrompts } from "./suggested-prompts";

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
 * The typed quick actions the model proposed on the CURRENT turn (#631, ADR
 * 0053): the newest assistant message's `suggest_actions` output, re-validated
 * client-side so only the internal-only typed set ever renders. Older turns'
 * chips fall away as the conversation moves on.
 */
function currentQuickActions(messages: UIMessage[]): QuickAction[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "tool-suggest_actions" && "output" in part) {
        return parseQuickActions((part.output as { actions?: unknown } | null)?.actions);
      }
    }
    return [];
  }
  return [];
}

/**
 * The financial assistant's contextual layer (#629, container decided in S0
 * #628): a FAB opens an overlay side panel (desktop) / bottom sheet (mobile)
 * that survives in-app navigation because it mounts in the root layout. The
 * conversation is ephemeral — client state only, nothing persisted (#627).
 * Styles live in globals.css (`assistant*` classes, design-system tokens).
 */

const transport = new DefaultChatTransport({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ messages }) => ({
    // The screen context rides along at send time so "¿qué estoy viendo?"
    // reflects the route the user is on NOW, not where the panel opened.
    body: {
      messages,
      screenContext: deriveScreenContext(
        window.location.pathname,
        window.location.search,
      ),
    },
  }),
});

export default function AssistantLayer() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const { messages, sendMessage, status, error } = useChat({ transport });
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  // Set the instant BEFORE we close so focus returns to the trigger, not the
  // top of the page — but never steals focus on first mount (#633, a11y).
  const closingRef = useRef(false);

  const busy = status === "submitted" || status === "streaming";
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

  function close() {
    closingRef.current = true;
    setOpen(false);
  }

  function seed(text: string) {
    if (busy) return;
    void sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  function runAction(action: QuickAction) {
    if (action.type === "openInternalSource") {
      // Client navigation only — the panel is mounted in the root layout, so the
      // conversation survives the route change underneath it (S0 decision).
      router.push(action.href);
      return;
    }
    seed(action.prompt);
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (closingRef.current) {
      fabRef.current?.focus();
      closingRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (text === "" || busy) return;
    void sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setDraft("");
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

      <div className="assistantMessages">
        {messages.length === 0 ? (
          <div className="assistantHint">
            <p>Pregunta sobre tu patrimonio: cifras, deudas, liquidez, exposición…</p>
            <div aria-label="Preguntas sugeridas" className="assistantPrompts">
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
        {messages.map((message) => (
          <div className={`assistantMsg ${message.role}`} key={message.id}>
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                return <p key={`${message.id}-${i}`}>{part.text}</p>;
              }
              if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                const name =
                  "toolName" in part ? String(part.toolName) : part.type.slice(5);
                // suggest_actions renders as chips below, not as tool activity.
                if (name === "suggest_actions") return null;
                return (
                  <span className="assistantTool" key={`${message.id}-${i}`}>
                    → {name}
                  </span>
                );
              }
              return null;
            })}
          </div>
        ))}
        {error ? (
          <p className="assistantError" role="alert">
            El asistente no ha podido responder. Vuelve a intentarlo.
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      {quickActions.length > 0 ? (
        <div aria-label="Acciones sugeridas" className="assistantActions">
          {quickActions.map((action, i) => (
            <button
              className={`assistantChip ${action.type}`}
              key={`${action.label}-${i}`}
              onClick={() => runAction(action)}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      <form className="assistantInputRow" onSubmit={submit}>
        <input
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Pregunta sobre esta pantalla…"
          ref={inputRef}
          value={draft}
        />
        <button disabled={busy || draft.trim() === ""} type="submit">
          Enviar
        </button>
      </form>
    </section>
  );
}
