import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DESTINATIONS,
  renderCapabilityDestinations,
} from "./capability-destinations";
import { MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE } from "./maintainer-alert-evidence";
import { buildChatSystemPrompt } from "./system-prompt";

describe("capability destinations (#1524)", () => {
  it("names the rent-expenses surface the 2026-08-21 transcript could not find", () => {
    const rent = CAPABILITY_DESTINATIONS.find((entry) => entry.id === "rent-expenses");

    expect(rent).toBeDefined();
    // The four things the answer he never got had to contain: the ficha, the section,
    // the field, and the cadence — an annual IBI typed against a monthly rent nets
    // out to nonsense, so the cadence is part of the destination, not a nicety.
    expect(rent?.where).toMatch(/ficha del inmueble/i);
    expect(rent?.where).toMatch(/cobros/i);
    expect(rent?.where).toMatch(/campo\s+Gastos/i);
    expect(rent?.where).toMatch(/misma cadencia/i);
    // And the accordion it hides behind. `CobrosSection` renders inside the
    // «Configuración avanzada» `<details>`, which is closed unless ?abrir=operaciones
    // — so an answer that stops at «en Cobros» still leaves the user hunting.
    expect(rent?.where).toMatch(/configuración avanzada/i);
  });

  it("refuses the net-in-the-amount workaround by name, with both reasons", () => {
    const rent = CAPABILITY_DESTINATIONS.find((entry) => entry.id === "rent-expenses");

    // The assistant proposed it once cornered: «introduce el Alquiler Neto Anual en el
    // campo de Cobros … aunque la etiqueta siga diciendo Cobros». It breaks the ledger
    // (a payout is what ARRIVED, ADR 0054) AND it does not work (with `expenses_minor`
    // NULL the engine discards the rent either way, ADR 0076). Both halves are needed:
    // a model told only the first one will weigh it against helping the user and lose.
    expect(rent?.neverInstead).toMatch(/0054/);
    expect(rent?.neverInstead).toMatch(/0076/);
    expect(rent?.neverInstead).toMatch(/no arregla el cálculo/i);
  });

  it("keeps every entry pointing somewhere a user can actually go", () => {
    for (const entry of CAPABILITY_DESTINATIONS) {
      expect(entry.where.trim().length, entry.id).toBeGreaterThan(0);
      // A destination with no surface in it is a shrug with extra words.
      expect(entry.where, entry.id).toMatch(/\/[a-z-]+|ficha|«[^»]+»/);
    }
    expect(new Set(CAPABILITY_DESTINATIONS.map((e) => e.id)).size).toBe(
      CAPABILITY_DESTINATIONS.length,
    );
  });

  it("is read by the prompt and by the alert refusal — one map, no drift", () => {
    // The acceptance criterion of #1524, and the reason this module exists at all: the
    // destinations were already written once, inside the refusal message, and the rent
    // entry was missing there. Asserting both consumers against the SAME map is what
    // stops the next surface from landing in one copy only.
    const prompt = buildChatSystemPrompt(null);

    for (const entry of CAPABILITY_DESTINATIONS) {
      expect(prompt, entry.id).toContain(entry.where);
    }
    expect(MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE).toContain(
      renderCapabilityDestinations(),
    );
    expect(prompt).toContain(renderCapabilityDestinations());
  });

  it("renders the workarounds after the destinations, in one sentence", () => {
    const rendered = renderCapabilityDestinations();

    expect(rendered.endsWith(".")).toBe(true);
    for (const entry of CAPABILITY_DESTINATIONS) {
      expect(rendered, entry.id).toContain(entry.where);
      if (entry.neverInstead) {
        expect(rendered.indexOf(entry.neverInstead)).toBeGreaterThan(
          rendered.indexOf(entry.where),
        );
      }
    }
  });
});
