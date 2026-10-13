import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { FormRefusal, refusalAria, refusalFor } from "./form-refusal";

const refused = { formId: "value", message: "El valor no es válido.", values: {} };

describe("refusalFor — a form reads only its own refusal", () => {
  test("the refusal of this form", () => {
    expect(refusalFor(refused, "value")).toBe(refused);
  });

  test("another form's refusal, or none, is nothing to this one", () => {
    expect(refusalFor(refused, "balance")).toBeNull();
    expect(refusalFor(null, "value")).toBeNull();
  });
});

describe("FormRefusal — the band its fields point at", () => {
  test("prints the message as an alert with the id", () => {
    expect(renderToStaticMarkup(<FormRefusal id="value-error" refusal={refused} />)).toBe(
      '<p class="errorBand" id="value-error" role="alert">El valor no es válido.</p>',
    );
  });

  test("prints nothing without a refusal", () => {
    expect(renderToStaticMarkup(<FormRefusal id="value-error" refusal={null} />)).toBe(
      "",
    );
  });
});

describe("refusalAria — a refused field says why and that it is invalid", () => {
  test("points at the band while it shows", () => {
    expect(refusalAria("value-error")).toEqual({
      "aria-describedby": "value-error",
      "aria-invalid": true,
    });
  });

  test("carries nothing while there is no band", () => {
    const markup = renderToStaticMarkup(<input {...refusalAria(undefined)} />);
    expect(markup).not.toContain("aria-");
  });
});
