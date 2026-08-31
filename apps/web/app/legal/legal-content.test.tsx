import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import AvisoLegalDocument from "./_documents/aviso-legal";
import NoAsesoramientoDocument from "./_documents/no-asesoramiento";
import PrivacidadDocument from "./_documents/privacidad";
import ReembolsosDocument from "./_documents/reembolsos";
import TerminosDocument from "./_documents/terminos";
import { LEGAL_DOCUMENTS, type LegalDocumentSlug } from "./legal-documents";
import { type LegalIdentity, resolveLegalIdentity } from "./legal-identity";

/**
 * Los cinco textos legales (#1172) llevan cláusulas que no son estilo: las exige
 * una norma, el merchant of record o una decisión ya cerrada (el wind-down del
 * lifetime de #1132, la promesa afinada de medición de #1131). Este test las
 * clava sobre el HTML renderizado — no sobre el fuente — para que un reescrito
 * de redacción pueda cambiar el tono pero no perder la cláusula.
 *
 * **Gate humano**: nada de esto sustituye la revisión de gestoría/abogado que el
 * slice deja pendiente antes de publicar.
 */

const IDENTITY: LegalIdentity = resolveLegalIdentity({
  WORTHLINE_LEGAL_CONTACT_EMAIL: "contacto@example.com",
  WORTHLINE_LEGAL_OPERATOR_NAME: "Nombre Apellido",
  WORTHLINE_LEGAL_POSTAL_ADDRESS: "Calle Falsa 123, 28001 Madrid",
  WORTHLINE_LEGAL_TAX_ID: "00000000X",
});

const DOCUMENTS: Record<LegalDocumentSlug, (identity: LegalIdentity) => string> = {
  "aviso-legal": (identity) =>
    renderToStaticMarkup(<AvisoLegalDocument identity={identity} />),
  "no-asesoramiento": (identity) =>
    renderToStaticMarkup(<NoAsesoramientoDocument identity={identity} />),
  privacidad: (identity) =>
    renderToStaticMarkup(<PrivacidadDocument identity={identity} />),
  reembolsos: (identity) =>
    renderToStaticMarkup(<ReembolsosDocument identity={identity} />),
  terminos: (identity) => renderToStaticMarkup(<TerminosDocument identity={identity} />),
};

const html = (slug: LegalDocumentSlug): string => DOCUMENTS[slug]!(IDENTITY);

function expectAll(slug: LegalDocumentSlug, anchors: string[]): void {
  const markup = html(slug);

  for (const anchor of anchors) {
    expect(markup, `${slug} debe decir «${anchor}»`).toContain(anchor);
  }
}

describe("aviso legal · LSSI art. 10 (#1172)", () => {
  test("publishes name, tax id and a direct contact channel from the environment", () => {
    expectAll("aviso-legal", [
      "Nombre Apellido",
      "00000000X",
      "contacto@example.com",
      "Calle Falsa 123, 28001 Madrid",
      "Ley 34/2002",
    ]);
  });

  test("names the merchant of record as seller of record of the payment", () => {
    expectAll("aviso-legal", ["Paddle.com Market Ltd", "vendedor de registro"]);
  });

  test("says what is missing instead of publishing a silent hole", () => {
    const pending = renderToStaticMarkup(
      <AvisoLegalDocument identity={resolveLegalIdentity({})} />,
    );

    expect(pending).toContain("pendiente de configurar");
    // Al visitante se le dice que faltan datos; los nombres de las variables
    // del despliegue van al log del servidor, no a una página pública.
    expect(pending).not.toContain("WORTHLINE_LEGAL_");
  });
});

describe("términos de servicio (#1172)", () => {
  test("describes the service by what it does NOT do", () => {
    expectAll("terminos", [
      "no custodia",
      "no ejecuta órdenes",
      "no presta asesoramiento",
    ]);
  });

  test("puts the payment on the merchant of record, not on worthline", () => {
    expectAll("terminos", [
      "Paddle.com Market Ltd",
      "vendedor de registro",
      "factura con el IVA",
    ]);
  });

  test("writes the honest wind-down of the lifetime plan (#1132)", () => {
    expectAll("terminos", [
      "mientras el servicio siga alojado y operativo",
      "con al menos 30 días de antelación",
      "exportación",
      "reembolsará",
      // #1132 cerró «reembolso ÍNTEGRO a quien lo pida»: el prorrateo del
      // research quedó superado y rebajarlo aquí debilitaría la obligación.
      "<strong>íntegra</strong>",
    ]);
    expect(html("terminos")).not.toContain("proporcional");
  });

  test("writes the subscriber wind-down too, not only the lifetime one (#1132)", () => {
    expectAll("terminos", [
      "no se cobra ninguna renovación más",
      "hasta el final del periodo ya pagado",
      "plan gratuito",
    ]);
  });

  test("limits beta expectations without touching the consumer's imperative rights", () => {
    expectAll("terminos", [
      "beta",
      "tal cual",
      "garantías legales",
      "Real Decreto Legislativo 1/2007",
    ]);
  });

  test("keeps the consumer's forum and links the sibling texts", () => {
    expectAll("terminos", [
      "domicilio del consumidor",
      'href="/legal/privacidad"',
      'href="/legal/reembolsos"',
      'href="/legal/no-asesoramiento"',
    ]);
  });

  test("commits to a single maintainer support channel, with no SLA (#1132)", () => {
    expectAll("terminos", [
      "sin un acuerdo de nivel de servicio",
      "contacto@example.com",
    ]);
  });
});

describe("política de privacidad · RGPD (#1172)", () => {
  test("states the legal bases article by article", () => {
    expectAll("privacidad", [
      "artículo 6.1.b",
      "artículo 6.1.f",
      "no pedimos consentimiento",
    ]);
  });

  test("lists every processor, and says which of them still receives nothing", () => {
    expectAll("privacidad", [
      "Vercel",
      "Turso",
      // Quien autentica la web es Google (next-auth); WorkOS solo firma el
      // OAuth del servidor MCP (ADR 0034). Declararlo al revés publicaba una
      // cesión que no ocurre y callaba la que sí.
      "Google (inicio de sesión)",
      "WorkOS",
      "OAuth del servidor MCP",
      "Resend",
      "Sentry",
      "Google (Gemini API)",
      "Cerebras",
      // Sentry y Resend son slices posteriores del PRD #1171: declarados, pero
      // sin recibir aún ni un dato.
      "aún no activo",
      "no reciben ningún dato",
    ]);
  });

  test("does not declare a provider that receives nothing (#1278)", () => {
    // Groq salió del pool el 2026-07-30: declararlo como encargado sería
    // declarar una cesión que no ocurre.
    expect(html("privacidad")).not.toContain("Groq");
  });

  test("explains the US transfers and the mechanism that covers them", () => {
    expectAll("privacidad", ["Estados Unidos", "Data Privacy Framework", "cláusulas"]);
  });

  test("is explicit about the financial context sent to the LLM providers", () => {
    expectAll("privacidad", [
      "contexto financiero",
      "no entrenan",
      "solo cuando escribes al asistente",
      // La conversación es efímera: estado de cliente, nada persistido (#627).
      // Prometer un borrado que no existe sería anunciar un derecho sin producto.
      "<strong>no guarda</strong> la conversación",
    ]);
  });

  test("routes the RGPD rights through the export and the reset that already exist", () => {
    expectAll("privacidad", [
      "exportación",
      "eliminar el workspace",
      "un mes",
      "Agencia Española de Protección de Datos",
    ]);
  });

  test("carries the refined no-telemetry promise (#1131)", () => {
    expectAll("privacidad", [
      "sin telemetría de uso ni analytics de terceros",
      "onboarding completado",
    ]);
  });

  test("explains why there is no cookie banner", () => {
    expectAll("privacidad", ["cookies técnicas", "no mostramos un banner"]);
  });
});

describe("política de reembolsos (#1172)", () => {
  test("honours the 14 days for the subscription AND the lifetime", () => {
    expectAll("reembolsos", ["14 días", "también", "lifetime", "sin dar explicaciones"]);
  });

  test("sends the request to the merchant of record, and to us as a fallback", () => {
    expectAll("reembolsos", ["Paddle.com Market Ltd", "contacto@example.com"]);
  });

  test("repeats the wind-down promise so the lifetime buyer reads it here too", () => {
    expectAll("reembolsos", ["lifetime", "cesara"]);
  });
});

describe("aviso de no asesoramiento · perímetro CNMV (#1172)", () => {
  test("uses the wording agreed in the research, aligned with ADR 0045", () => {
    expectAll("no-asesoramiento", [
      "herramienta de seguimiento e información",
      "recomendaciones personalizadas",
      "no ejecuta operaciones ni custodia fondos",
      "carácter meramente informativo",
    ]);
  });

  test("names the regulator perimeter it stays out of", () => {
    expectAll("no-asesoramiento", ["CNMV", "asesoramiento en materia de inversión"]);
  });
});

describe("todos los documentos (#1172)", () => {
  test("every registered document renders a heading and its own body", () => {
    for (const document of LEGAL_DOCUMENTS) {
      const markup = html(document.slug);

      expect(markup, document.slug).toContain(`<h2>${document.title}</h2>`);
      expect(markup.length, document.slug).toBeGreaterThan(1000);
    }
  });

  test("no legal source hardcodes the operator's real identity (repo público)", () => {
    // El repo es público: nombre, NIF, domicilio y email del prestador entran
    // por env. Un NIF/NIE español o un email no-ejemplo en el fuente sería una
    // fuga de datos personales al historial de git.
    const directory = join(import.meta.dirname, "_documents");
    const sources = readdirSync(directory).map((name) => ({
      name,
      text: readFileSync(join(directory, name), "utf8"),
    }));

    expect(sources.length).toBe(5);

    for (const { name, text } of sources) {
      expect(text, `${name} parece llevar un NIF literal`).not.toMatch(
        /\b[XYZ]?\d{7,8}[A-Z]\b/,
      );
      const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
      for (const email of emails) {
        expect(email, `${name} lleva un email literal`).toMatch(/example\.(com|org)$/);
      }
    }
  });

  test("the operator identity is only ever read behind connection()", () => {
    // `process.env` leído durante el prerender congela el shell estático con los
    // valores del build; si el runtime tiene otros, el HTML servido y el árbol de
    // React dejan de coincidir y la hidratación revienta (React 418). El único
    // lector de la identidad es `legal-page.tsx`, y llama a `connection()` antes.
    const directory = import.meta.dirname;
    const readers = walkLegalSources(directory)
      // `legal-identity.ts` la declara; lo que se vigila es quién la llama.
      .filter(([name]) => name !== "legal-identity.ts")
      .filter(([, text]) => /\breadLegalIdentity\s*\(/.test(text))
      .map(([name]) => name);

    expect(readers).toEqual(["legal-page.tsx"]);

    const legalPage = readFileSync(join(directory, "legal-page.tsx"), "utf8");
    expect(legalPage).toContain('from "next/server"');
    expect(legalPage).toContain("await connection()");
  });
});

/** Cada fuente no-test bajo `app/legal/`, como pares `[ruta relativa, texto]`. */
function walkLegalSources(directory: string): Array<[string, string]> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkLegalSources(path).map(
        ([name, text]) => [`${entry.name}/${name}`, text] as [string, string],
      );
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];

    return [[entry.name, readFileSync(path, "utf8")] as [string, string]];
  });
}
