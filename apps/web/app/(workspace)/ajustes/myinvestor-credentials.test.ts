/**
 * What the MyInvestor connection keeps, and what the forms may send (#1879, ADR
 * 0114). The stored shapes are read back through a schema: a sealed blob that does
 * not parse is treated as absent, never half-trusted.
 */
import { describe, expect, test } from "vitest";
import {
  parseMyInvestorCode,
  parseMyInvestorLogin,
  readMyInvestorCredentials,
  readMyInvestorPending,
  serializeMyInvestorCredentials,
  serializeMyInvestorPending,
} from "./myinvestor-credentials";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe("stored credentials", () => {
  test("without the opt-in they hold the device and nothing else", () => {
    const json = serializeMyInvestorCredentials({ deviceId: "device-a" });

    expect(JSON.parse(json)).toEqual({ deviceId: "device-a" });
    expect(readMyInvestorCredentials(json)).toEqual({ deviceId: "device-a" });
  });

  test("with the opt-in they also hold the username, the password and who accepted when", () => {
    const stored = {
      acceptance: {
        acceptedAt: "2026-11-04T12:00:00.000Z",
        acceptedBy: "titular@example.com",
      },
      customerId: "12345678A",
      deviceId: "device-a",
      password: "secret",
    };

    expect(readMyInvestorCredentials(serializeMyInvestorCredentials(stored))).toEqual(
      stored,
    );
  });

  test("a blob that does not parse reads as null", () => {
    expect(readMyInvestorCredentials("{}")).toBeNull();
    expect(readMyInvestorCredentials("not json")).toBeNull();
    // A password without its acceptance is not a stored opt-in.
    expect(
      readMyInvestorCredentials(
        JSON.stringify({ customerId: "x", deviceId: "d", password: "p" }),
      ),
    ).toEqual({ deviceId: "d" });
  });
});

describe("the pending step", () => {
  test("round-trips, with the credentials only when the box was ticked", () => {
    const bare = {
      deviceId: "device-a",
      requestId: "request-a",
      save: null,
      signatureId: "signature-a",
    };
    const withSave = {
      ...bare,
      save: { acceptedBy: null, customerId: "12345678A", password: "secret" },
    };

    expect(readMyInvestorPending(serializeMyInvestorPending(bare))).toEqual(bare);
    expect(readMyInvestorPending(serializeMyInvestorPending(withSave))).toEqual(withSave);
    expect(readMyInvestorPending("{}")).toBeNull();
  });
});

describe("parseMyInvestorLogin", () => {
  test("reads the username upper-cased, the password as typed and the box", () => {
    expect(
      parseMyInvestorLogin(
        form({ customerId: " 12345678a ", password: " a b ", savePassword: "on" }),
      ),
    ).toEqual({
      ok: true,
      value: { customerId: "12345678A", password: " a b ", save: true },
    });
    expect(
      parseMyInvestorLogin(form({ customerId: "x1234567a", password: "p" })),
    ).toMatchObject({ ok: true, value: { save: false } });
  });

  test("refuses an empty username or password", () => {
    expect(parseMyInvestorLogin(form({ customerId: "", password: "p" }))).toMatchObject({
      ok: false,
    });
    expect(parseMyInvestorLogin(form({ customerId: "x", password: "" }))).toMatchObject({
      ok: false,
    });
  });
});

describe("parseMyInvestorCode", () => {
  test("accepts the digits of the SMS, spaces aside", () => {
    expect(parseMyInvestorCode(form({ code: " 123 456 " }))).toBe("123456");
  });

  test("refuses anything that is not a code", () => {
    expect(parseMyInvestorCode(form({ code: "" }))).toBeNull();
    expect(parseMyInvestorCode(form({ code: "12ab56" }))).toBeNull();
    expect(parseMyInvestorCode(form({ code: "1".repeat(20) }))).toBeNull();
  });
});
