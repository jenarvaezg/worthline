/**
 * Exposure profile hand-entry — the "Exposición" surface (PRD #539 S1, #541).
 *
 * Sits on the ficha of a hand-enterable investment (fund/etf/stock/index/
 * pension_plan — the `canHandEnterExposureProfile` gate lives in the page). The
 * profile is a *shared canonical row* keyed by the security's identity
 * (`isin ?? providerSymbol`), so it applies to EVERY holding of the same value
 * (ADR 0039). The user enters a geography vector (MSCI buckets, as percentages),
 * a single asset class, the TER (as a percent), a tracked index and a hedged
 * flag; the implicit `Otros` remainder (100 − Σ geography) is shown so what is
 * left undeclared is visible.
 *
 * Server-rendered, no client JS: the remainder is computed from the prefilled
 * profile at render (interaction-patterns §11 — an island for a live remainder
 * preview would not earn its JS weight for a rarely-touched settings form).
 * All parsing/among-fields maths lives in the pure `exposure-profile-form.ts`.
 */

import { formatDecimalAsPercentField } from "@web/intake-primitives";
import { listTrackedIndexLabels, type ExposureProfile } from "@worthline/domain";

import { PendingSubmit } from "@web/pending-submit";
import {
  EXPOSURE_ASSET_CLASS_LABELS,
  EXPOSURE_GEOGRAPHY_LABELS,
  geographyRemainderPercent,
} from "./exposure-profile-form";

type FormAction = (formData: FormData) => void | Promise<void>;

/** The single stored asset-class bucket (v1 stores `{ [class]: "1" }`), or "". */
function currentAssetClass(profile: ExposureProfile | null): string {
  const breakdown = profile?.breakdowns.assetClass;
  if (!breakdown) return "";
  const [bucket] = Object.keys(breakdown);
  return bucket ?? "";
}

/** A stored geography fraction as the percent string the field shows, or "". */
function geographyPercentField(profile: ExposureProfile | null, bucket: string): string {
  const raw = profile?.breakdowns.geography?.[bucket as never] as string | undefined;
  return raw === undefined ? "" : formatDecimalAsPercentField(Number(raw));
}

export function ExposureProfileSection({
  action,
  currentUrl,
  error,
  profile,
  profileKey,
}: {
  action: FormAction;
  currentUrl: string;
  /** A validation error (e.g. >100% breakdown) to surface at this section. */
  error?: string | null;
  profile: ExposureProfile | null;
  /** The resolved security identity the profile is keyed by (isin ?? providerSymbol). */
  profileKey: string;
}) {
  const geographyField = Object.fromEntries(
    EXPOSURE_GEOGRAPHY_LABELS.map(({ bucket }) => [
      bucket,
      geographyPercentField(profile, bucket),
    ]),
  ) as Record<string, string>;
  const remainder = geographyRemainderPercent(geographyField as never);
  const assetClass = currentAssetClass(profile);
  const terField =
    profile?.ter != null ? formatDecimalAsPercentField(Number(profile.ter)) : "";

  return (
    <section className="exposureProfile" aria-label="Exposición">
      <h3>Exposición</h3>
      <p className="infoNote">
        Se aplica a todas las posiciones de este valor (clave: {profileKey}).
      </p>

      {error ? (
        <p className="errorBand" role="alert">
          {error}
        </p>
      ) : null}

      <form action={action} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <fieldset className="ownershipGrid">
          <legend>Reparto geográfico (MSCI, %)</legend>
          {EXPOSURE_GEOGRAPHY_LABELS.map(({ bucket, label }) => (
            <label key={bucket}>
              {label}
              <input
                aria-label={`Peso de ${label} en %`}
                defaultValue={geographyField[bucket]}
                inputMode="decimal"
                name={`geo_${bucket}`}
              />
            </label>
          ))}
        </fieldset>

        <p className="infoNote">
          {remainder > 0
            ? `Sin declarar (implícito en Otros): ${remainder}%.`
            : remainder < 0
              ? `Los pesos suman más del 100% (${-remainder}% de más) — corrígelo antes de guardar.`
              : "Reparto completo al 100%."}
        </p>

        <label>
          Clase de activo
          <select defaultValue={assetClass} name="assetClass">
            <option value="">Sin especificar</option>
            {EXPOSURE_ASSET_CLASS_LABELS.map(({ bucket, label }) => (
              <option key={bucket} value={bucket}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          TER (comisión anual, en %)
          <input
            aria-label="TER en porcentaje"
            defaultValue={terField}
            inputMode="decimal"
            name="ter"
            placeholder="0,22"
          />
        </label>

        <label>
          Índice de referencia
          <input
            aria-label="Índice de referencia"
            autoComplete="off"
            defaultValue={profile?.trackedIndex ?? ""}
            list="tracked-index-catalog"
            name="trackedIndex"
            placeholder="p. ej. MSCI World"
          />
          <datalist id="tracked-index-catalog">
            {listTrackedIndexLabels().map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
        </label>

        <label className="checkLine">
          <input
            defaultChecked={profile?.hedged ?? false}
            name="hedged"
            type="checkbox"
          />{" "}
          Cubierto a EUR
        </label>

        <div className="formActions">
          <PendingSubmit pendingLabel="Guardando…">Guardar exposición</PendingSubmit>
          {profile ? (
            <button className="btnSmall" name="clear" type="submit" value="1">
              Vaciar
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
