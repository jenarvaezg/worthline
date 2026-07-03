"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";

import { deriveScreenContext } from "./screen-context";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
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
        type="button"
      >
        ✳
      </button>
    );
  }

  return (
    <section aria-label="Asistente financiero" className="assistantPanel" role="dialog">
      <header className="assistantHead">
        <h2>Asistente</h2>
        <button
          aria-label="Cerrar asistente"
          onClick={() => setOpen(false)}
          type="button"
        >
          ×
        </button>
      </header>

      <div className="assistantMessages">
        {messages.length === 0 ? (
          <p className="assistantHint">
            Pregunta sobre tu patrimonio: cifras, deudas, liquidez, exposición…
          </p>
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
