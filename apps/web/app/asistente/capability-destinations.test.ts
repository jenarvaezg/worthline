import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FEEDBACK_BUTTON_LABEL } from "@web/feedback/feedback-message";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DESTINATIONS,
  renderCapabilityDestinations,
  renderCapabilityDestinationsForPrompt,
} from "./capability-destinations";
import { FABRICATED_ALERT_NOTE } from "./fabricated-maintainer-alert";
import { MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE } from "./maintainer-alert-evidence";
import { buildChatSystemPrompt } from "./system-prompt";

/** Repo-relative read, so the static checks below say which file they are asserting. */
const source = (path: string): string =>
  readFileSync(join(process.cwd(), "app", path), "utf8");

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
      expect(MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE, entry.id).toContain(
        entry.where,
      );
    }
  });

  it("has both consumers CALL the module rather than carry their own copy", () => {
    // The check above compares CONTENT, and content is not enough: a consumer that
    // stopped importing this module and inlined the same prose today would still pass
    // it, and would drift the moment an entry changed. So this one is static — the two
    // files must call the renderer, and must not hold a destination literal of their
    // own. It is the exact failure mode the module was extracted to end.
    for (const file of [
      "asistente/system-prompt.ts",
      "asistente/maintainer-alert-evidence.ts",
    ]) {
      const text = source(file);
      expect(text, file).toContain('from "./capability-destinations"');
      expect(text, file).toMatch(/renderCapabilityDestinations(ForPrompt)?\(\)/);
      expect(text, file).not.toContain("/ajustes/conexiones");
      expect(text, file).not.toContain("campo Gastos");
    }
  });

  it("keeps the rent workaround OUT of the alert refusal", () => {
    // Two renderers, one map. The prompt teaches conduct on every turn, so «no metas el
    // neto en el importe» belongs there; a figures-mismatch refusal lecturing about
    // rental expenses is noise, and that message's own contract is to name surfaces «as
    // the places to LOOK, not as the answer».
    const workaround = CAPABILITY_DESTINATIONS.find(
      (entry) => entry.id === "rent-expenses",
    )?.neverInstead;

    expect(workaround).toBeDefined();
    expect(buildChatSystemPrompt(null)).toContain(workaround);
    expect(MAINTAINER_ALERT_WITHOUT_DISCREPANCY_MESSAGE).not.toContain(workaround);
  });

  it("renders the workarounds after the destinations, in one sentence", () => {
    const rendered = renderCapabilityDestinationsForPrompt();

    expect(rendered.endsWith(".")).toBe(true);
    expect(rendered.startsWith(renderCapabilityDestinations())).toBe(true);
    for (const entry of CAPABILITY_DESTINATIONS) {
      expect(rendered, entry.id).toContain(entry.where);
      if (entry.neverInstead) {
        expect(rendered.indexOf(entry.neverInstead)).toBeGreaterThan(
          rendered.indexOf(entry.where),
        );
      }
    }
  });

  it("sends a user who wants to report something to the feedback button (#1174)", () => {
    // 2026-08-21: «levanta una incidencia sobre esto … ¿hay un número de ticket?». The
    // assistant invented one, then had to confess there was nowhere to send it. Now there
    // is, and the honest answer has three halves: the button, by its own words; that the
    // USER sends it (the assistant cannot, and #1525 accuses it if it says it did); and
    // that no ticket number comes back, which is what he asked for twice.
    const feedback = CAPABILITY_DESTINATIONS.find(
      (entry) => entry.id === "user-feedback",
    );

    expect(feedback).toBeDefined();
    expect(feedback?.where).toContain(`«${FEEDBACK_BUTTON_LABEL}»`);
    expect(feedback?.where).toMatch(/barra superior/i);
    expect(feedback?.where).toMatch(/propio usuario/i);
    expect(feedback?.where).toMatch(/no puedes enviarla/i);
    expect(feedback?.where).toMatch(/sin número de ticket/i);
  });

  it("points the faked-incident note at the same button", () => {
    // The note painted under a turn that claimed an incident it never filed used to end
    // in «hoy worthline no puede tramitar un aviso por ti». That was the truth until
    // #1174; left as is, it would now send the user away from the channel that exists.
    expect(FABRICATED_ALERT_NOTE).toContain(`«${FEEDBACK_BUTTON_LABEL}»`);
    expect(FABRICATED_ALERT_NOTE).toContain("no hay ticket");
    expect(FABRICATED_ALERT_NOTE).not.toMatch(/no puede tramitar un aviso por ti\.$/);
  });

  it("names a button the workspace topbar actually mounts", () => {
    // Same drift guard as the accordion below, pointed at the feedback button: the
    // launcher prints the shared label, and the workspace layout mounts it in the topbar.
    const launcher = source("feedback/feedback-launcher.tsx");
    const layout = source("(workspace)/layout.tsx");

    expect(launcher).toContain("{FEEDBACK_BUTTON_LABEL}");
    expect(layout).toContain("<FeedbackMount />");
    expect(layout.indexOf("<FeedbackMount />")).toBeGreaterThan(
      layout.indexOf('className="topbarEnd"'),
    );
  });

  it("names the accordion the UI actually renders", () => {
    // The rent destination quotes «Configuración avanzada» because `CobrosSection` sits
    // inside that `<details>`. Nothing in the type system ties this prose to the page,
    // so a rename there would leave the assistant confidently sending users to a
    // control that no longer exists — the drift this module was born to prevent,
    // pointing at the UI instead of at a sibling module. Anchored by reading the UI.
    //
    // Since #1607 those are two files: the ficha owns the accordion, and the shared
    // Cobros panel mounts the section its families place inside it. That the panel
    // really lands in the accordion is pinned by rendering, in the ficha's own
    // `page-families.test.tsx` — here it is the WORDS that must still match.
    const page = source("(workspace)/patrimonio/[id]/editar/page.tsx");
    const panel = source("(workspace)/patrimonio/[id]/editar/_chrome/payouts-panel.tsx");
    const rent = CAPABILITY_DESTINATIONS.find((entry) => entry.id === "rent-expenses");

    expect(page).toContain("<summary>Configuración avanzada</summary>");
    expect(panel).toContain("<CobrosSection");
    expect(rent?.where).toContain("Configuración avanzada");
  });
});
