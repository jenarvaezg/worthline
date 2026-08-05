import { describe, expect, test } from "vitest";

import { urlWantsRevealedSection } from "./reveal-section";

/**
 * The reveal link and the server read one question from this module (#1365): the
 * island opens the section on click, and Back/Forward has to fold it again — both
 * decided by whether the live URL still carries what the href asks for.
 */
const HREF = "/patrimonio/wl_hld_fondo/editar?abrir=operaciones#operaciones";

describe("urlWantsRevealedSection (#1365)", () => {
  test("the URL the link mirrors asks for the section", () => {
    expect(urlWantsRevealedSection("?abrir=operaciones", HREF)).toBe(true);
  });

  test("Back to the folded view does not", () => {
    expect(urlWantsRevealedSection("", HREF)).toBe(false);
    expect(urlWantsRevealedSection("?abrir=otra", HREF)).toBe(false);
  });

  test("unrelated params riding along do not change the answer", () => {
    // A mutation's ok token or a scope param lands on this URL constantly; the
    // question is only about what the href itself sets.
    expect(urlWantsRevealedSection("?ok=saved&abrir=operaciones", HREF)).toBe(true);
    expect(urlWantsRevealedSection("?ok=saved", HREF)).toBe(false);
  });

  test("an href that sets no param never asks for a reveal", () => {
    expect(urlWantsRevealedSection("?abrir=operaciones", "/patrimonio#operaciones")).toBe(
      false,
    );
  });

  test("the fragment is not part of the question", () => {
    // `#abrir=x` is not a search param, and reading it as one would open the
    // section for a URL that never asked.
    expect(urlWantsRevealedSection("", "/x#abrir=operaciones")).toBe(false);
  });
});
