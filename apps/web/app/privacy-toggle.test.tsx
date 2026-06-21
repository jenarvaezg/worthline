import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import PrivacyToggle from "./privacy-toggle";

describe("PrivacyToggle", () => {
  test("renders an eye icon and hide-numbers label when privacy is off", () => {
    const markup = renderToStaticMarkup(
      <PrivacyToggle privacyMode={false} returnTo="/" />,
    );

    expect(markup).toContain('action="/privacy"');
    expect(markup).toContain('aria-label="Ocultar números"');
    expect(markup).toContain("<svg");
    expect(markup).not.toContain('class="active"');
  });

  test("renders a slashed eye icon and show-numbers label when privacy is on", () => {
    const markup = renderToStaticMarkup(
      <PrivacyToggle privacyMode={true} returnTo="/historico" />,
    );

    expect(markup).toContain('name="returnTo"');
    expect(markup).toContain('value="/historico"');
    expect(markup).toContain('aria-label="Mostrar números"');
    expect(markup).toContain('class="active"');
  });
});
