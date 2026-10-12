import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { FormSeedProvider } from "./form-seed";
import { OperationRecordForm, RecordOperationSubmit } from "./operation-record-form";
import { OperationsBookProvider } from "./operations-book";

const noop = async () => {};

function render(overrides: Partial<ComponentProps<typeof OperationRecordForm>> = {}) {
  return renderToStaticMarkup(
    <OperationsBookProvider operations={[]}>
      <OperationRecordForm
        assetId="asset_1"
        currentUrl="/patrimonio/wl_hld_1/editar"
        formError={null}
        heldUnits="0"
        recordAction={noop}
        today="2026-06-25"
        {...overrides}
      />
    </OperationsBookProvider>,
  );
}

describe("required/optional convention (#603)", () => {
  test("required fields show no orphan asterisk", () => {
    expect(render()).not.toMatch(/>\*</);
  });

  test("optional field (comisiones) is marked '(opcional)'", () => {
    expect(render()).toContain("(opcional)");
  });

  test("required fields keep their accessible required semantics", () => {
    // Visual asterisk goes, but units/price are still genuinely required.
    expect(render()).toContain('aria-required="true"');
  });
});

describe("double-submit guard on the record button (#1394)", () => {
  test("the idle button is enabled and reads 'Registrar operación'", () => {
    const html = renderToStaticMarkup(<RecordOperationSubmit pending={false} />);

    expect(html).toContain("Registrar operación");
    expect(html).not.toContain("disabled");
  });

  test("while the action is in flight the button is disabled", () => {
    // The second of two clicks never reaches the server: this is what stopped a
    // sell from being recorded twice and eating ~1.000 € of net worth.
    const html = renderToStaticMarkup(<RecordOperationSubmit pending={true} />);

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Registrando…");
  });

  test("the form renders the record button in its idle state", () => {
    expect(render()).toContain("Registrar operación");
  });
});

describe("currency at the capture (#1401)", () => {
  test("the money fields are labelled EUR by default, as before", () => {
    const html = render();

    expect(html).toContain("Precio por unidad (EUR)");
    expect(html).toContain("Comisiones (EUR)");
    // Nothing to warn about: a euro apunte is not converted.
    expect(html).not.toContain("tipo del BCE");
  });

  test("the picker starts on the currency the holding last captured", () => {
    const html = render({ defaultCurrency: "USD" });

    expect(html).toContain("Precio por unidad (USD)");
    expect(html).toContain("Comisiones (USD)");
    // The server markup carries the selection, so the no-JS post sends USD too.
    expect(html).toContain('<option value="USD" selected="">');
    // Said before the submit, so the user knows WHICH day's rate applies.
    expect(html).toContain("tipo del BCE del día de la operación");
  });

  test("a rejected capture round-trips the currency instead of falling back to EUR", () => {
    const html = render({
      formError: {
        formId: "operation",
        message: "No hay tipo de cambio del BCE de USD para el 23 ene 2026.",
        values: { currency: "USD", pricePerUnit: "8,00", units: "0,255" },
      },
    });

    expect(html).toContain("Precio por unidad (USD)");
  });
});

describe("a refusal is printed beside the form that produced it", () => {
  test("no refusal, no band", () => {
    expect(render()).not.toContain('role="alert"');
  });

  test("an oversell form error uses the gold warning band and the confirm checkbox", () => {
    const html = render({
      formError: {
        formId: "operation",
        message:
          "Tienes 31,999; vas a vender 32. Si es el redondeo del bróker, confirma. Si no, corrige las unidades.",
        values: { oversellPending: "1", units: "32" },
      },
      heldUnits: "31.999",
    });

    expect(html).toContain('class="warningBand"');
    expect(html).not.toContain('id="operation-error" class="errorBand"');
    expect(html).toContain("redondeo del bróker");
    expect(html).toContain("Confirmo la venta");
    expect(html).toContain('name="oversellConfirmed"');
    expect(html).toContain('type="checkbox"');
  });

  test("a regular operation error stays a red error band, with no confirm checkbox", () => {
    const html = render({
      formError: {
        formId: "operation",
        message: "Las unidades son obligatorias.",
        values: {},
      },
    });

    expect(html).toContain('class="errorBand"');
    expect(html).not.toContain("Confirmo la venta");
  });

  test("another form's refusal is not this form's to print", () => {
    const html = render({
      formError: { formId: "transfer", message: "Falta el destino.", values: {} },
    });

    expect(html).not.toContain("Falta el destino.");
  });
});

describe("the form returns to the URL it is given (#1826)", () => {
  test("its terminal lands on the ficha it was posted from", () => {
    expect(render()).toContain('value="/patrimonio/wl_hld_1/editar"');
  });
});

describe("«Añadir otra» re-opens it on the last one's day and currency (#1829)", () => {
  const seeded = (overrides: Partial<ComponentProps<typeof OperationRecordForm>> = {}) =>
    renderToStaticMarkup(
      <OperationsBookProvider operations={[]}>
        <FormSeedProvider
          seed={{ values: { currency: "USD", executedAt: "2026-09-12" } }}
        >
          <OperationRecordForm
            assetId="asset_1"
            currentUrl="/patrimonio/wl_hld_1/editar"
            defaultCurrency="EUR"
            formError={null}
            heldUnits="0"
            recordAction={noop}
            today="2026-10-12"
            {...overrides}
          />
        </FormSeedProvider>
      </OperationsBookProvider>,
    );

  test("the date and the currency are the last operation's, the figures start blank", () => {
    const html = seeded();

    expect(html).toContain('value="2026-09-12"');
    expect(html).not.toContain('value="2026-10-12"');
    expect(html).toContain('<option value="USD" selected="">');
    expect(html).toContain("Precio por unidad (USD)");
    expect(html).not.toMatch(/name="units"[^>]*value=/);
  });

  test("a refusal's own values still win over the seed", () => {
    const html = seeded({
      formError: {
        formId: "operation",
        message: "Las unidades son obligatorias.",
        values: { currency: "GBP", executedAt: "2026-08-01" },
      },
    });

    expect(html).toContain('value="2026-08-01"');
    expect(html).toContain('<option value="GBP" selected="">');
  });

  test("with no seed it opens on today and the ledger's last currency, as before", () => {
    const html = render({ defaultCurrency: "EUR" });

    expect(html).toContain('value="2026-06-25"');
    expect(html).toContain('<option value="EUR" selected="">');
  });
});
