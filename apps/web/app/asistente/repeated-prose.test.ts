import { describe, expect, test } from "vitest";

import { withoutRepeatedProse } from "./repeated-prose";

/**
 * The reported turn (#1317): an alta from an attachment where the model wrote its
 * summary before `propose_holding` and wrote it again in the step the SDK opens
 * after `suggest_actions`.
 */
const SUMMARY =
  "He preparado una propuesta para dar de alta el fondo Vanguard Global Stock " +
  "con su valor de hoy, 12.585 € a 28 de julio de 2026.\n\n" +
  "Para que el valor de esta posición se actualice solo, he resuelto su símbolo " +
  "de mercado; si lo confirmas, worthline lo seguirá a diario.";

describe("withoutRepeatedProse (#1317)", () => {
  test("prints a verbatim recap of the whole answer once", () => {
    expect(withoutRepeatedProse([SUMMARY, SUMMARY])).toEqual([SUMMARY, ""]);
  });

  test("keeps a single answer untouched", () => {
    expect(withoutRepeatedProse([SUMMARY])).toEqual([SUMMARY]);
  });

  test("keeps what the second part ADDS and drops only the repeated blocks", () => {
    const [first, second] = withoutRepeatedProse([
      SUMMARY,
      `${SUMMARY}\n\n¿Quieres que revise también tu colchón de liquidez?`,
    ]);

    expect(first).toBe(SUMMARY);
    expect(second).toBe("¿Quieres que revise también tu colchón de liquidez?");
  });

  test("hides the recap while it is still streaming in, so it never flashes", () => {
    // The half-typed block is a prefix of one already printed: held back now, and
    // still held back when it completes.
    expect(
      withoutRepeatedProse([SUMMARY, "He preparado una propuesta para dar"]),
    ).toEqual([SUMMARY, ""]);
  });

  test("matches across re-wrapping and casing", () => {
    expect(
      withoutRepeatedProse([
        "He preparado una propuesta para dar de alta el fondo.",
        "he preparado una propuesta\npara dar   de alta el fondo.",
      ]),
    ).toEqual(["He preparado una propuesta para dar de alta el fondo.", ""]);
  });

  test("a longer block that merely opens the same way survives", () => {
    const [, second] = withoutRepeatedProse([
      "He preparado la propuesta.",
      "He preparado la propuesta, y he descartado la anterior.",
    ]);

    expect(second).toBe("He preparado la propuesta, y he descartado la anterior.");
  });

  test("repeats inside a single part are printed once too", () => {
    expect(withoutRepeatedProse([`${SUMMARY}\n\n${SUMMARY}`])).toEqual([SUMMARY]);
  });

  test("leaves a text carrying a code fence exactly as it arrived", () => {
    const fenced = "Mira:\n\n```\nlinea\n\nlinea\n```";

    expect(withoutRepeatedProse([fenced, fenced])).toEqual([fenced, fenced]);
  });

  test("returns one entry per part, empty parts included", () => {
    expect(withoutRepeatedProse(["", SUMMARY, ""])).toEqual(["", SUMMARY, ""]);
  });
});
