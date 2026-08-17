import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The wiring: the «Acciones recomendadas:» list the model writes in its own prose
 * leaves the text and comes back as chips. The rule lives in `prose-actions.ts`;
 * what this file proves is that the panel actually applies it — the reported bug
 * was literal `[Ver detalle…](«Colección Numista»)` brackets in the reply, plus a
 * follow-up question the reader had to retype by hand.
 *
 * Rendered through the onboarding variant like the #1286 test: the floating panel
 * ships closed, and both surfaces share `ConversationParts` and the chip row.
 */

let chatMessages: UIMessage[] = [];

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatMessages,
    sendMessage: vi.fn(),
    status: "ready",
    error: undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bienvenida",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import AssistantLayer from "./assistant-layer";

const PROSE = [
  "La moneda más cara es la de 148 €.",
  "",
  "Acciones recomendadas:",
  "- [Ver detalle de la Colección Numista](«Colección Numista»)",
  "- ¿Cuál es el valor total de mi colección de monedas en Numista?",
].join("\n");

function assistantTurn(text: string, actions: unknown[]): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text },
      {
        type: "tool-suggest_actions",
        toolCallId: "t1",
        state: "output-available",
        input: {},
        output: { actions },
      },
    ],
  } as unknown as UIMessage;
}

function markup(): string {
  return renderToStaticMarkup(<AssistantLayer variant="onboarding" />);
}

beforeEach(() => {
  chatMessages = [];
});

describe("AssistantLayer · the action block never stays in the prose", () => {
  test("trims the block and turns its items into chips", () => {
    chatMessages = [
      assistantTurn(PROSE, [
        {
          type: "openInternalSource",
          label: "Ver detalle de la Colección Numista",
          href: "/patrimonio/wl_hld_x/editar",
        },
      ]),
    ];

    const html = markup();

    // The prose keeps the answer and loses the duplicate block…
    expect(html).toContain("La moneda más cara es la de 148 €.");
    expect(html).not.toContain("Acciones recomendadas");
    expect(html).not.toContain("Colección Numista]");
    // …and both items are buttons: the source, and the follow-up question.
    expect(html).toContain('href="/patrimonio/wl_hld_x/editar"');
    expect(html).toContain("¿Cuál es el valor total de mi colección de monedas");
    expect(html.match(/assistantChip/g)).toHaveLength(2);
  });

  test("does not show the same source twice when the block repeats a chip", () => {
    chatMessages = [
      assistantTurn("Texto.\n\nAcciones recomendadas:\n- [Ver patrimonio](/patrimonio)", [
        { type: "openInternalSource", label: "Ir a patrimonio", href: "/patrimonio" },
      ]),
    ];

    expect(markup().match(/assistantChip/g)).toHaveLength(1);
  });

  test("shows no raw markdown when nothing in the block converts (#1375)", () => {
    chatMessages = [
      assistantTurn(
        [
          "Tu plan de pensiones vale 12.000 €.",
          "",
          "Acciones de seguimiento:",
          "• [Abrir detalles del Plan de Pensiones](openInternalSource?holding=«N5396 - Myinvestor Indexado Global PP»&section=patrimonio)",
          "• Ver resumen patrimonial [blocked]",
        ].join("\n"),
        [],
      ),
    ];

    const html = markup();

    expect(html).toContain("Tu plan de pensiones vale 12.000 €.");
    expect(html).not.toContain("Acciones de seguimiento");
    expect(html).not.toContain("openInternalSource");
    expect(html).not.toContain("blocked");
    expect(html).not.toContain("assistantChip");
  });

  test("turns the narrated tool call into a chip instead of printing it (#1407)", () => {
    chatMessages = [
      assistantTurn(
        [
          "El saldo pendiente de la hipoteca de Plasencia es de 41.230 €.",
          "",
          "// Acciones sugeridas:",
          '- [Analizar el estado de la deuda actual] (runSuggestedAnalysis:{"prompt":"Muéstrame el estado actual de la hipoteca de Plasencia."})',
          "- Abrir el detalle de la hipoteca [blocked]",
        ].join("\n"),
        [],
      ),
    ];

    const html = markup();

    expect(html).toContain("El saldo pendiente de la hipoteca de Plasencia");
    // Neither the commented heading, nor the tool's own name in the prose, nor its
    // JSON, nor the tag the model invented for itself: the reader gets one button.
    // (`Acciones sugeridas` and `runSuggestedAnalysis` do survive as the chip row's
    // aria-label and the chip's class, which is the whole point of the fix.)
    expect(html).not.toContain("Acciones sugeridas:");
    expect(html).not.toContain("runSuggestedAnalysis:");
    expect(html).not.toContain("{&quot;prompt&quot;");
    expect(html).not.toContain("blocked");
    expect(html).toMatch(
      /<button[^>]*class="assistantChip runSuggestedAnalysis"[^>]*>Analizar el estado de la deuda actual</,
    );
    expect(html.match(/assistantChip/g)).toHaveLength(1);
  });

  test("leaves prose alone when there is no action block", () => {
    chatMessages = [assistantTurn("Tus mayores posiciones:\n- Fondo A\n- Fondo B", [])];

    const html = markup();

    expect(html).toContain("Fondo A");
    expect(html).toContain("Fondo B");
  });
});
