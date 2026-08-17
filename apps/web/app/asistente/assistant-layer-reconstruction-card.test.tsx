import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * La tarjeta de reconstrucción del día que abrió #1422 (2026-08-17): Jorge sube el
 * cuadro de amortización de su hipoteca, se leen 49 saldos, se pinta la curva… y el
 * botón «Confirmar» nace deshabilitado bajo «No cuadra con el saldo conocido —
 * revisa los puntos». Él contesta lo único que puede contestar: «los datos que te
 * aporto son correctos», y tiene razón: la curva viva de la app dice 51.886,90 €,
 * el documento dice 51.881,00 € y el único número que discrepa —52.375,33 €— es el
 * que él tecleó a mano en julio y contra el que se le exigía cuadrar AL CÉNTIMO.
 *
 * Este fichero fija en el MARKUP, que es donde se lo encontró, las cuatro cosas que
 * tenían que cambiar: el botón vivo, el descuadre dicho en vez de prohibido, el
 * ancla acusada con las tres cifras y el aviso de qué hará el confirmar.
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
  usePathname: () => "/asistente",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import AssistantLayer from "./assistant-layer";
import { reconcileReconstructedBalance } from "./balance-reconciliation";
import type { ReconstructionCorrectionProposal } from "./correction-proposal-contract";

function markupFor(
  proposal: ReconstructionCorrectionProposal,
  tool = "propose_reconstruction",
): string {
  chatMessages = [
    {
      id: "a1",
      parts: [
        {
          output: proposal,
          state: "output-available",
          toolCallId: "call-1",
          type: `tool-${tool}`,
        } as unknown as UIMessage["parts"][number],
      ],
      role: "assistant",
    },
  ];
  return renderToStaticMarkup(
    <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
  );
}

/** `Intl` usa espacio duro antes del €; las aserciones leen el texto plano. */
function plain(html: string): string {
  return html.replace(/(&#x27;|&#39;)/g, "'").replace(/[\u00a0\u202f]/g, " ");
}

/** El cuadro del Santander, reducido a lo que decide la garantía. */
function jorgeProposal(
  over: Partial<{
    declaredMinor: number;
    modelMinor: number;
    resultingMinor: number;
  }> = {},
): ReconstructionCorrectionProposal {
  const reconciliation = reconcileReconstructedBalance({
    declaredMinor: 52_375_33,
    modelMinor: 51_886_90,
    resultingMinor: 51_881_00,
    ...over,
  });
  return {
    anchorMinor: reconciliation.expectedMinor,
    curve: [
      { balanceMinor: 52_500_00, date: "2026-06-01" },
      { balanceMinor: reconciliation.resultingMinor, date: "2026-08-17" },
    ],
    draft: { proposalId: "wl_prp_1422" },
    folio: "1 propuesta · 1 holding · 1 lote atómico",
    guarantee: {
      anchorMinor: reconciliation.expectedMinor,
      resultingMinor: reconciliation.resultingMinor,
      state: reconciliation.matches ? "reconciled" : "mismatch",
    },
    holding: { id: "wl_hld_hipoteca", name: "Hipoteca Santander" },
    mode: "reconstruir",
    proposalType: "correction",
    reconciliation,
    series: [
      { balanceMinor: 52_500_00, date: "2026-06-01", origin: "assistant" },
      {
        balanceMinor: reconciliation.resultingMinor,
        date: "2026-08-17",
        origin: "assistant",
      },
    ],
    summary: "Reconstrucción de «Hipoteca Santander»",
  };
}

/** El botón «Confirmar» de la tarjeta, con su atributo disabled si lo tiene. */
function confirmButton(html: string): string {
  const match = html.match(/<button[^>]*>(?:Confirmar|Guardando…)<\/button>/);
  return match?.[0] ?? "";
}

beforeEach(() => {
  chatMessages = [];
});

describe("ReconstructionProposalCard · el cuadro que no se podía aplicar (#1422)", () => {
  test("el botón nace vivo: 6 € contra la curva viva ya no son un descuadre", () => {
    const html = plain(markupFor(jorgeProposal()));

    expect(confirmButton(html)).not.toContain("disabled");
    expect(html).toContain("Cuadra dentro del margen");
    expect(html).not.toContain("revisa los puntos");
  });

  test("el ancla que ni su propia curva reproduce se nombra con las tres cifras", () => {
    const html = plain(markupFor(jorgeProposal()));

    expect(html).toContain(
      "Tu saldo declarado (52.375 €) no coincide ni con tu propia curva (51.887 €); el documento dice 51.881 €.",
    );
  });

  test("se anuncia lo que el confirmar le hará al saldo declarado", () => {
    const html = plain(markupFor(jorgeProposal()));

    expect(html).toContain(
      "Al confirmar, tu saldo declarado pasará de 52.375 € a 51.881 €.",
    );
  });

  test("un descuadre de verdad se puede aplicar, diciendo quién manda", () => {
    const html = plain(markupFor(jorgeProposal({ resultingMinor: 40_000_00 })));

    expect(confirmButton(html)).not.toContain("disabled");
    expect(html).toContain("No cuadra");
    expect(html).toContain("mandará el documento");
  });

  /**
   * #1423: una enmienda devuelve la MISMA propuesta de corrección desde otra tool, y
   * si el render no la reconoce el usuario ve un turno sin tarjeta — exactamente el
   * «he actualizado la propuesta» sin propuesta que la issue arregla.
   */
  test("la propuesta enmendada también pinta su tarjeta, con lo quitado a la vista", () => {
    const proposal = jorgeProposal();
    const html = plain(
      markupFor(
        {
          ...proposal,
          series: [
            proposal.series[0]!,
            {
              ...proposal.series[1]!,
              excluded: true,
              origin: "user",
              reason: "Excluido a tu petición",
            },
          ],
          summary: "Reconstrucción de «Hipoteca Santander» (enmendada)",
        },
        "propose_reconstruction_amendment",
      ),
    );

    expect(html).toContain("Reconstrucción de «Hipoteca Santander» (enmendada)");
    expect(html).toContain("Excluido a tu petición");
    // La casilla del punto quitado llega marcada: reincluirlo es un clic.
    expect(html).toContain('type="checkbox" checked');
    expect(confirmButton(html)).not.toContain("disabled");
  });

  test("sin ningún punto que aplicar no hay nada que confirmar", () => {
    const proposal = jorgeProposal();
    const html = plain(
      markupFor({
        ...proposal,
        series: proposal.series.map((point) => ({ ...point, excluded: true })),
      }),
    );

    expect(confirmButton(html)).toContain("disabled");
  });
});
