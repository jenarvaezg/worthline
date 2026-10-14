/**
 * The owner's «Acceso de solo lectura» section (#1844): its server render in each
 * state — empty, with a list, and with every refusal the door can give. The
 * optimistic fold and the share plan are pinned in `sharing/read-only-sharing.test.ts`.
 */
import {
  SHARE_FAILURE_MESSAGE,
  shareRefusalMessage,
} from "@web/sharing/read-only-sharing";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ReadOnlyAccessSection } from "./read-only-access-section";

const noop = async () => ({ ok: true }) as const;

function render(
  overrides: Partial<Parameters<typeof ReadOnlyAccessSection>[0]> = {},
): string {
  return renderToStaticMarkup(
    <ReadOnlyAccessSection
      initialEmail=""
      initialError={null}
      ownerEmail="jose@example.com"
      revokeAction={noop}
      shareAction={noop}
      today="2026-10-14"
      viewers={[]}
      {...overrides}
    />,
  );
}

const ANA = { email: "ana@example.com", since: "2026-10-01", userId: "u_ana" };
const LUIS = { email: "luis@example.com", since: "2026-10-03", userId: "u_luis" };

describe("«Acceso de solo lectura» (#1844)", () => {
  test("empty: says nobody else sees the workspace, and offers the door", () => {
    const html = render();

    expect(html).toContain("Acceso de solo lectura");
    expect(html).toContain("Nadie más ve tu espacio.");
    expect(html).toContain('name="viewerEmail"');
    expect(html).toContain("Dar acceso");
    expect(html).not.toContain("Quitar acceso");
  });

  test("says what the person will and will not be able to do, and that the owner tells them", () => {
    expect(render()).toContain(
      "Verá todas tus cifras y fichas. No podrá cambiar nada, ni usar el asistente, ni descargar la exportación. Puedes quitarle el acceso cuando quieras. Avísale tú: entrará con su cuenta de Google de esa dirección.",
    );
  });

  test("with a list: each viewer's email, since when, and «Quitar acceso» behind a confirmation", () => {
    const html = render({ viewers: [ANA, LUIS] });

    expect(html).toContain("ana@example.com");
    expect(html).toContain("desde el 01/10/2026");
    expect(html).toContain("luis@example.com");
    expect(html).toContain("desde el 03/10/2026");
    expect(html.match(/<summary[^>]*>Quitar acceso<\/summary>/g)).toHaveLength(2);
    expect(html).toContain("Confirmar: quitar acceso");
    expect(html).toContain('name="viewerUserId" value="u_ana"');
    // Each control says whose row it is, so a screen reader hears more than
    // «Quitar acceso» five times.
    expect(html).toContain('aria-label="Quitar acceso a ana@example.com"');
    expect(html).toContain('aria-label="Confirmar: quitar acceso a ana@example.com"');
    expect(html).toContain('aria-label="Quitar acceso a luis@example.com"');
    expect(html).toContain("2 de 5");
    expect(html).not.toContain("Nadie más ve tu espacio.");
  });

  test.each([
    ["an invalid email", shareRefusalMessage("invalid-email")],
    ["oneself", shareRefusalMessage("self-share")],
    ["someone who already has access", shareRefusalMessage("already-granted")],
    ["the limit of five", shareRefusalMessage("viewer-limit")],
    ["a failure to create the access", SHARE_FAILURE_MESSAGE],
  ])("shows the refusal for %s inline, beside the door, with what was typed", (_l, message) => {
    const html = render({ initialEmail: "ana@", initialError: message });

    expect(html).toContain(`<p class="formError" role="alert">${message}</p>`);
    expect(html).toContain('value="ana@"');
  });

  test("the share form posts to the action and leaves validation to the section's own words", () => {
    const html = render();

    expect(html).toMatch(/<form[^>]*novalidate/i);
  });
});
