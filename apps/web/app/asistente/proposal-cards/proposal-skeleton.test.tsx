import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ProposalActions } from "./proposal-actions";
import type { ProposalCardResult, ProposalMutation } from "./proposal-mutation";
import { ProposalOutcome } from "./proposal-outcome";

/**
 * The skeleton eleven proposal cards used to repeat verbatim (#1617), pinned where
 * the user meets it: the markup. Everything asserted here was copied identically in
 * every card before the collapse, so a change to any of it is a change to all of
 * them at once — which is the whole point, and the reason it needs a test of its own.
 *
 * The guardian below states which cards are OUT of the pattern and why. It is not a
 * style rule: each exception is a card whose confirm/discard is genuinely a different
 * ceremony, and folding it in would have moved nodes on screen.
 */

type Mutation = ProposalMutation<ProposalCardResult>;

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    actionsDisabled: false,
    confirm: () => {},
    discard: () => {},
    mutationsDisabled: false,
    mutationsDisabledMessage: "En la demo no se puede guardar.",
    pending: false,
    result: null,
    ...overrides,
  };
}

describe("ProposalOutcome (#1617)", () => {
  test("says nothing until the card acts", () => {
    expect(
      renderToStaticMarkup(
        <ProposalOutcome applied="Corrección aplicada." mutation={mutation()} />,
      ),
    ).toBe("");
  });

  test("the shut demo gate speaks in the outcome's place, and is not a live region", () => {
    const html = renderToStaticMarkup(
      <ProposalOutcome
        applied="Corrección aplicada."
        mutation={mutation({ mutationsDisabled: true })}
      />,
    );

    expect(html).toBe('<p class="assistantError">En la demo no se puede guardar.</p>');
    // The gate sentence is there BEFORE anything happens, so announcing it would
    // interrupt a screen reader reading the proposal itself.
    expect(html).not.toContain("aria-live");
  });

  test("a success is announced politely, in the card's own words", () => {
    expect(
      renderToStaticMarkup(
        <ProposalOutcome
          applied="Traspaso anotado."
          mutation={mutation({ result: { status: "applied" } })}
        />,
      ),
    ).toBe(
      '<p aria-live="polite" class="assistantOk" role="status">Traspaso anotado.</p>',
    );
  });

  test("a card that reads its payload back writes the sentence itself", () => {
    // The reconcile batch counts what it created (#1108): the payload reaches the
    // sentence, and the tone stays the shared `assistantOk`.
    type Applied = { created: number; status: "applied"; updated: number };
    const applied: Applied = { created: 2, status: "applied", updated: 1 };

    expect(
      renderToStaticMarkup(
        <ProposalOutcome<Applied | { status: "discarded" }>
          applied={(result) =>
            `Cartera cuadrada: ${result.created} creados, ${result.updated} actualizados.`
          }
          mutation={mutation({ result: applied }) as ProposalMutation<Applied>}
        />,
      ),
    ).toBe(
      '<p aria-live="polite" class="assistantOk" role="status">Cartera cuadrada: 2 creados, 1 actualizados.</p>',
    );
  });

  test("a card that also picks the tone gets to say it is a warning", () => {
    // A reconstructed debt history whose captures went without the debt (#1438).
    expect(
      renderToStaticMarkup(
        <ProposalOutcome
          applied={() => ({
            className: "assistantWarning",
            text: "Historia reconstruida · 3 capturas, 1 sin la deuda.",
          })}
          mutation={mutation({ result: { status: "applied" } })}
        />,
      ),
    ).toBe(
      '<p aria-live="polite" class="assistantWarning" role="status">Historia reconstruida · 3 capturas, 1 sin la deuda.</p>',
    );
  });

  test("the discard says the same sentence in every card", () => {
    expect(
      renderToStaticMarkup(
        <ProposalOutcome
          applied="Traspaso anotado."
          mutation={mutation({ result: { status: "discarded" } })}
        />,
      ),
    ).toBe(
      '<p aria-live="polite" class="assistantError" role="status">Propuesta descartada.</p>',
    );
  });

  test("a failure prints the server's own message, never the success sentence", () => {
    for (const status of ["blocked", "error"] as const) {
      expect(
        renderToStaticMarkup(
          <ProposalOutcome
            applied="Traspaso anotado."
            mutation={mutation({ result: { message: "No se pudo aplicar.", status } })}
          />,
        ),
      ).toBe(
        '<p aria-live="polite" class="assistantError" role="status">No se pudo aplicar.</p>',
      );
    }
  });
});

describe("ProposalActions (#1617)", () => {
  test("Confirmar is the primary and Descartar the secondary, in that order", () => {
    expect(renderToStaticMarkup(<ProposalActions mutation={mutation()} />)).toBe(
      '<div class="assistantProposalActions">' +
        '<button type="button">Confirmar</button>' +
        '<button class="secondary" type="button">Descartar</button>' +
        "</div>",
    );
  });

  test("«Guardando…» rides the primary alone", () => {
    const html = renderToStaticMarkup(
      <ProposalActions mutation={mutation({ actionsDisabled: true, pending: true })} />,
    );

    expect(html).toContain('<button disabled="" type="button">Guardando…</button>');
    expect(html).toContain("Descartar");
  });

  test("the card's own extra condition adds to the shared one, never replaces it", () => {
    // The correction asks for a verified guarantee, the reconcile for a non-empty
    // batch, the reconstruction for its gate — all on top of pending/demo/settled.
    const html = renderToStaticMarkup(
      <ProposalActions confirmDisabled mutation={mutation()} />,
    );

    expect(html).toContain('<button disabled="" type="button">Confirmar</button>');
    // And it stops at the confirm: a proposal you cannot apply is still one you
    // can throw away.
    expect(html).toContain('<button class="secondary" type="button">Descartar</button>');
  });

  test("a card may rename its discard without touching the rest", () => {
    // The reconcile card, whose rows have their own «quitar» control (#1373).
    expect(
      renderToStaticMarkup(
        <ProposalActions discardLabel="Descartar la propuesta" mutation={mutation()} />,
      ),
    ).toContain("Descartar la propuesta");
  });

  test("a proposal with no discard paints one button, not a dead second one", () => {
    expect(
      renderToStaticMarkup(<ProposalActions mutation={mutation({ discard: null })} />),
    ).toBe(
      '<div class="assistantProposalActions">' +
        '<button type="button">Confirmar</button>' +
        "</div>",
    );
  });
});

/**
 * Who is in and who is out, said out loud (#1617). Three cards keep their own
 * confirm/discard on purpose:
 *
 * - the statement card, whose discard is a reducer with focus management — it
 *   REPLACES the card with a status paragraph the focus moves to;
 * - the valuation card, whose discard unmounts the card entirely;
 * - the mixed-document card, which has a single «Confirmar todo» and no discard at
 *   all.
 *
 * The balance-history card takes the hook and the outcome but keeps its lone
 * button: its proposal has no discard, so there is no pair to wrap.
 */
describe("the cards outside the pattern, and why (#1617)", () => {
  const directory = join(import.meta.dirname, ".");
  const sources = new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
      .map((name) => [name, readFileSync(join(directory, name), "utf8")] as const),
  );

  function paintersOf(needle: string): string[] {
    return [...sources]
      .filter(([, source]) => source.includes(needle))
      .map(([name]) => name)
      .sort();
  }

  test("the transition that drives a proposal lives in the hook", () => {
    expect(paintersOf("useTransition")).toEqual([
      "mixed-document.tsx",
      "property-valuation.tsx",
      "statement.tsx",
    ]);
  });

  test("«Propuesta descartada.» is written once for the pattern", () => {
    // The statement card says it from its own reducer state, not from a result.
    expect(paintersOf("Propuesta descartada.")).toEqual([
      "proposal-outcome.tsx",
      "statement.tsx",
    ]);
  });

  test("the button row is painted in one place for the pattern", () => {
    expect(paintersOf('className="assistantProposalActions"')).toEqual([
      "property-valuation.tsx",
      "proposal-actions.tsx",
      "statement.tsx",
    ]);
  });

  test("every card of the pattern reads the skeleton from the shared hook", () => {
    expect(paintersOf("useProposalMutation")).toEqual([
      "balance-history.tsx",
      "correction.tsx",
      "early-repayment.tsx",
      "holding-creation.tsx",
      "holding-trash.tsx",
      "operation.tsx",
      "property-acquisition.tsx",
      "reconcile.tsx",
      "reconstruction.tsx",
      "transfer.tsx",
    ]);
  });
});
