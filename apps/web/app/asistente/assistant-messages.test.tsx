import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import AssistantMessages from "./assistant-messages";
import { THIRD_PARTY_AI_NOTICE_TEXT } from "./third-party-ai-notice";

/**
 * #955: the third-party AI notice must stay visible at the top of the chat in
 * every relevant state — empty starter, an active conversation, or after error.
 */
describe("AssistantMessages third-party notice (#955)", () => {
  test("shows the notice on an empty chat", () => {
    const html = renderToStaticMarkup(
      <AssistantMessages>
        <div className="assistantHint">
          <p>Pregunta sobre tu patrimonio…</p>
        </div>
      </AssistantMessages>,
    );

    expect(html).toContain(THIRD_PARTY_AI_NOTICE_TEXT);
    expect(html).toContain('role="note"');
    expect(html.indexOf("assistantThirdPartyNotice")).toBeLessThan(
      html.indexOf("assistantHint"),
    );
  });

  test("shows the notice during a conversation", () => {
    const html = renderToStaticMarkup(
      <AssistantMessages>
        <div className="assistantMsg user">
          <p>¿Cómo va mi patrimonio?</p>
        </div>
        <div className="assistantMsg assistant">
          <p>Tu patrimonio neto es estable.</p>
        </div>
      </AssistantMessages>,
    );

    expect(html).toContain(THIRD_PARTY_AI_NOTICE_TEXT);
    expect(html.indexOf("assistantThirdPartyNotice")).toBeLessThan(
      html.indexOf("assistantMsg"),
    );
  });

  test("shows the notice after an error", () => {
    const html = renderToStaticMarkup(
      <AssistantMessages>
        <div className="assistantMsg user">
          <p>¿Cuánto debo?</p>
        </div>
        <p className="assistantError" role="alert">
          El asistente no ha podido responder. Vuelve a intentarlo.
        </p>
      </AssistantMessages>,
    );

    expect(html).toContain(THIRD_PARTY_AI_NOTICE_TEXT);
    expect(html).toContain('role="alert"');
    expect(html.indexOf("assistantThirdPartyNotice")).toBeLessThan(
      html.indexOf("assistantError"),
    );
  });
});
