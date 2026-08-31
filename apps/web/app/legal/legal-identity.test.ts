import { describe, expect, test } from "vitest";

import {
  LEGAL_IDENTITY_ENV,
  MERCHANT_OF_RECORD,
  resolveLegalIdentity,
} from "./legal-identity";

/**
 * Identidad del prestador (#1172, LSSI art. 10). El repo es público, así que
 * nombre, NIF, contacto y domicilio NO viven en el código: entran por env. Este
 * seam es puro para que la decisión «¿qué falta por configurar?» se pueda probar
 * sin tocar `process.env` ni renderizar una página.
 */

const CONFIGURED = {
  [LEGAL_IDENTITY_ENV.contactEmail]: "hola@example.com",
  [LEGAL_IDENTITY_ENV.operatorName]: "Nombre Apellido",
  [LEGAL_IDENTITY_ENV.postalAddress]: "Calle Falsa 123, Madrid",
  [LEGAL_IDENTITY_ENV.taxId]: "00000000X",
} as const;

describe("resolveLegalIdentity (#1172)", () => {
  test("reads the operator identity out of the environment", () => {
    const identity = resolveLegalIdentity(CONFIGURED);

    expect(identity).toEqual({
      contactEmail: "hola@example.com",
      missing: [],
      operatorName: "Nombre Apellido",
      postalAddress: "Calle Falsa 123, Madrid",
      taxId: "00000000X",
    });
  });

  test("names every missing mandatory var instead of inventing a value", () => {
    const identity = resolveLegalIdentity({});

    expect(identity.operatorName).toBeNull();
    expect(identity.taxId).toBeNull();
    expect(identity.contactEmail).toBeNull();
    // El domicilio postal es prudencia, no obligación (basta un canal directo
    // y efectivo, art. 10.1.a LSSI), así que su ausencia no es un hueco.
    expect(identity.postalAddress).toBeNull();
    expect(identity.missing).toEqual([
      LEGAL_IDENTITY_ENV.operatorName,
      LEGAL_IDENTITY_ENV.taxId,
      LEGAL_IDENTITY_ENV.contactEmail,
    ]);
  });

  test("treats blank and whitespace-only values as absent", () => {
    const identity = resolveLegalIdentity({
      ...CONFIGURED,
      [LEGAL_IDENTITY_ENV.postalAddress]: "   ",
      [LEGAL_IDENTITY_ENV.taxId]: "",
    });

    expect(identity.taxId).toBeNull();
    expect(identity.postalAddress).toBeNull();
    expect(identity.missing).toEqual([LEGAL_IDENTITY_ENV.taxId]);
  });

  test("trims the configured values", () => {
    const identity = resolveLegalIdentity({
      ...CONFIGURED,
      [LEGAL_IDENTITY_ENV.contactEmail]: "  hola@example.com  ",
    });

    expect(identity.contactEmail).toBe("hola@example.com");
  });
});

describe("merchant of record (#1172)", () => {
  test("names the seller of record of the payment, not worthline", () => {
    // El MoR es el vendedor legal del cobro; el aviso legal y los términos
    // tienen que decirlo con nombre y enlace a sus condiciones.
    expect(MERCHANT_OF_RECORD.name).toBe("Paddle.com Market Ltd");
    expect(MERCHANT_OF_RECORD.termsUrl).toMatch(/^https:\/\/www\.paddle\.com\//);
  });
});
