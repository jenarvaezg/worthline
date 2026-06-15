/**
 * Statement upload — the "Cargar movimientos" surface (ADR 0018, S1 / #174).
 *
 * Sits under the operations editor on a `derived` investment. Pick the broker
 * (MyInvestor only for now) and a `.csv` export; on submit the bound action
 * parses it, creates an operation per executed row, and ripples history once.
 *
 * Server-action driven, zero client JS (ADR 0009): the form POSTs and the page
 * re-renders from the store after the action's redirect (success banner) or
 * redirects back with an error the editar page surfaces. No preview yet — that
 * is Slice 3; S1 is a minimal confirm.
 */

export function StatementUploadSection({
  action,
  currentUrl,
}: {
  action: (formData: FormData) => Promise<void>;
  currentUrl: string;
}) {
  return (
    <section aria-label="Cargar movimientos">
      <h3>Cargar movimientos</h3>
      <p className="contextLabel">
        Sube el archivo de órdenes exportado por tu bróker para crear las operaciones de
        esta inversión.
      </p>

      <form action={action} className="stackForm inversionesForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <label>
          Bróker
          <select defaultValue="myinvestor" name="broker">
            <option value="myinvestor">MyInvestor</option>
          </select>
        </label>

        <label>
          Archivo de órdenes (.csv)
          <input accept=".csv,text/csv" name="file" required type="file" />
        </label>

        <button type="submit">Cargar movimientos</button>
      </form>
    </section>
  );
}
