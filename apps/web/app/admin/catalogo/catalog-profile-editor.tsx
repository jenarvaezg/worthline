"use client";

/**
 * The detail-panel editors for the catalog (PRD #711 S4, decision #941). Three
 * separate gestures, each a thin shell over its server action: SAVE (create a
 * new draft or replace an existing profile's content), REKEY (change an existing
 * profile's identity — separate from save), and DELETE (with confirmation).
 *
 * Inputs are CONTROLLED (bound to draft state), so a rejected submit keeps the
 * admin's typed values instead of resetting them, and the undeclared remainder
 * is shown live per dimension (contract #940 honesty). The authoritative
 * validation still runs server-side in the domain; its error surfaces inline.
 */

import {
  EXPOSURE_ASSET_CLASS_LABELS,
  EXPOSURE_GEOGRAPHY_LABELS,
  GLOBAL_EXPOSURE_ASSET_CLASS_BUCKETS,
  type GlobalExposureProfile,
} from "@worthline/domain";
import { startTransition, useActionState, useEffect, useState } from "react";

import {
  type CatalogActionResult,
  deleteCatalogProfileAction,
  rekeyCatalogProfileAction,
  saveCatalogProfileAction,
} from "./actions";
import { COVERAGE_EPSILON, identityText, sumWeights } from "./catalog-triage";

const IDLE: CatalogActionResult = { status: "idle" };

// Mirrors the domain's `InvestmentPriceProvider` union — kept in sync manually
// because the union has no runtime array to iterate.
const PRICE_PROVIDERS = ["yahoo", "stooq", "finect", "coingecko"] as const;

/** The raw identity fields of an existing profile, for hidden-field assembly. */
function identityFields(profile: GlobalExposureProfile): {
  isin: string;
  priceProvider: string;
  providerSymbol: string;
} {
  return {
    isin: profile.identity.kind === "isin" ? profile.identity.isin : "",
    priceProvider:
      profile.identity.kind === "provider" ? profile.identity.priceProvider : "",
    providerSymbol:
      profile.identity.kind === "provider" ? profile.identity.providerSymbol : "",
  };
}

/** An existing profile's identity as hidden form fields (save-update + delete). */
function IdentityHiddenFields({ profile }: { profile: GlobalExposureProfile }) {
  const fields = identityFields(profile);
  return (
    <>
      <input name="isin" type="hidden" value={fields.isin} />
      <input name="priceProvider" type="hidden" value={fields.priceProvider} />
      <input name="providerSymbol" type="hidden" value={fields.providerSymbol} />
    </>
  );
}

const ASSET_CLASS_LABELS = EXPOSURE_ASSET_CLASS_LABELS.filter((entry) =>
  (GLOBAL_EXPOSURE_ASSET_CLASS_BUCKETS as readonly string[]).includes(entry.bucket),
);

interface CurrencyRow {
  /** Stable React key while editing — currency codes may be blank or duplicated. */
  id: number;
  code: string;
  weight: string;
}

interface EditorDraft {
  displayName: string;
  ter: string;
  trackedIndex: string;
  hedgedToCurrency: string;
  geography: Record<string, string>;
  assetClass: Record<string, string>;
  currency: CurrencyRow[];
  isin: string;
  priceProvider: string;
  providerSymbol: string;
}

function draftFromProfile(profile: GlobalExposureProfile | null): EditorDraft {
  return {
    displayName: profile?.displayName ?? "",
    ter: profile?.ter ?? "",
    trackedIndex: profile?.trackedIndex ?? "",
    hedgedToCurrency: profile?.hedgedToCurrency ?? "",
    geography: { ...(profile?.breakdowns.geography ?? {}) },
    assetClass: { ...(profile?.breakdowns.assetClass ?? {}) },
    currency: Object.entries(profile?.breakdowns.currency ?? {}).map(
      ([code, weight], index) => ({ id: index, code, weight }),
    ),
    isin: profile?.identity.kind === "isin" ? profile.identity.isin : "",
    priceProvider:
      profile?.identity.kind === "provider" ? profile.identity.priceProvider : "",
    providerSymbol:
      profile?.identity.kind === "provider" ? profile.identity.providerSymbol : "",
  };
}

function pruneWeights(source: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [bucket, weight] of Object.entries(source)) {
    if (String(weight).trim()) {
      cleaned[bucket] = String(weight).trim();
    }
  }
  return cleaned;
}

function currencyObject(rows: CurrencyRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { code, weight } of rows) {
    const key = code.trim().toUpperCase();
    if (key && weight.trim()) {
      out[key] = weight.trim();
    }
  }
  return out;
}

function draftBreakdownsJson(draft: EditorDraft): string {
  const out: Record<string, Record<string, string>> = {};
  const geography = pruneWeights(draft.geography);
  const assetClass = pruneWeights(draft.assetClass);
  const currency = currencyObject(draft.currency);
  if (Object.keys(geography).length) out.geography = geography;
  if (Object.keys(currency).length) out.currency = currency;
  if (Object.keys(assetClass).length) out.assetClass = assetClass;
  return JSON.stringify(out);
}

function formatPercent(fraction: number): string {
  return `${(Math.round(fraction * 1000) / 10).toLocaleString("es-ES")}%`;
}

/** Whether any dimension's declared weights exceed 100% — an invalid draft. */
function draftExceedsHundred(draft: EditorDraft): boolean {
  return [
    pruneWeights(draft.geography),
    pruneWeights(draft.assetClass),
    currencyObject(draft.currency),
  ].some((weights) => sumWeights(weights) > 1 + COVERAGE_EPSILON);
}

/** Live "declarado / remanente" line for a dimension, and an over-100% warning. */
function CoverageMeter({ weights }: { weights: Record<string, string> }) {
  const declared = sumWeights(weights);
  const remainder = Math.max(0, 1 - declared);
  const over = declared > 1 + COVERAGE_EPSILON;
  return (
    <p className="catalogRemainder">
      Declarado {formatPercent(Math.min(1, declared))}
      {over ? (
        <span className="catalogOver"> · suma {formatPercent(declared)} &gt; 100%</span>
      ) : remainder > 1e-9 ? (
        <span className="catalogAvisoInline">
          {" "}
          · sin declarar {formatPercent(remainder)}
        </span>
      ) : (
        <span className="catalogComplete"> · completo</span>
      )}
    </p>
  );
}

function useResultEffect(
  state: CatalogActionResult,
  onResult: (result: CatalogActionResult) => void,
) {
  useEffect(() => {
    if (state.status === "saved" || state.status === "deleted") {
      onResult(state);
    }
  }, [state, onResult]);
}

interface SaveFormProps {
  mode: "create" | "update";
  profile: GlobalExposureProfile | null;
  onResult: (result: CatalogActionResult) => void;
}

export function CatalogSaveForm({ mode, profile, onResult }: SaveFormProps) {
  const [draft, setDraft] = useState<EditorDraft>(() => draftFromProfile(profile));
  const [state, dispatch, pending] = useActionState(saveCatalogProfileAction, IDLE);
  useResultEffect(state, onResult);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => dispatch(new FormData(event.currentTarget)));
  }

  const isCreate = mode === "create";

  return (
    <form className="catalogForm stackForm" onSubmit={submit}>
      <input name="mode" type="hidden" value={mode} />
      <input name="breakdowns" type="hidden" value={draftBreakdownsJson(draft)} />

      <fieldset className="catalogFieldset">
        <legend>Identidad</legend>
        {isCreate ? (
          <>
            <p className="catalogHint">
              Un ISIN válido (con checksum) o, si no lo hay, proveedor + símbolo. La
              identidad solo se fija al crear; luego cambia por «Rekey».
            </p>
            <label>
              ISIN
              <input
                autoComplete="off"
                name="isin"
                onChange={(e) => setDraft({ ...draft, isin: e.target.value })}
                placeholder="IE00B4L5Y983"
                value={draft.isin}
              />
            </label>
            <div className="catalogTwoCol">
              <label>
                Proveedor de precio
                <select
                  name="priceProvider"
                  onChange={(e) => setDraft({ ...draft, priceProvider: e.target.value })}
                  value={draft.priceProvider}
                >
                  <option value="">—</option>
                  {PRICE_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Símbolo
                <input
                  autoComplete="off"
                  name="providerSymbol"
                  onChange={(e) => setDraft({ ...draft, providerSymbol: e.target.value })}
                  placeholder="VWCE.DE"
                  value={draft.providerSymbol}
                />
              </label>
            </div>
          </>
        ) : (
          <>
            {/* Identity is fixed for an existing profile; ship it as hidden fields
                so `update` re-resolves the same key, and show it read-only. */}
            {profile ? <IdentityHiddenFields profile={profile} /> : null}
            <p className="catalogIdentity">
              {profile ? identityText(profile.identity) : "—"}
            </p>
          </>
        )}
      </fieldset>

      <fieldset className="catalogFieldset">
        <legend>Presentación</legend>
        <label>
          Nombre visible
          <input
            name="displayName"
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            value={draft.displayName}
          />
        </label>
        <div className="catalogTwoCol">
          <label>
            TER (fracción 0–1)
            <input
              inputMode="decimal"
              name="ter"
              onChange={(e) => setDraft({ ...draft, ter: e.target.value })}
              placeholder="0.0012"
              value={draft.ter}
            />
          </label>
          <label>
            Divisa de cobertura
            <input
              maxLength={3}
              name="hedgedToCurrency"
              onChange={(e) =>
                setDraft({ ...draft, hedgedToCurrency: e.target.value.toUpperCase() })
              }
              placeholder="EUR"
              value={draft.hedgedToCurrency}
            />
          </label>
        </div>
        <label>
          Índice replicado
          <input
            name="trackedIndex"
            onChange={(e) => setDraft({ ...draft, trackedIndex: e.target.value })}
            placeholder="MSCI World"
            value={draft.trackedIndex}
          />
        </label>
      </fieldset>

      <fieldset className="catalogFieldset">
        <legend>Geografía</legend>
        <div className="catalogWeights">
          {EXPOSURE_GEOGRAPHY_LABELS.map(({ bucket, label }) => (
            <label key={bucket}>
              {label}
              <input
                inputMode="decimal"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    geography: { ...draft.geography, [bucket]: e.target.value },
                  })
                }
                placeholder="0"
                value={draft.geography[bucket] ?? ""}
              />
            </label>
          ))}
        </div>
        <CoverageMeter weights={pruneWeights(draft.geography)} />
      </fieldset>

      <fieldset className="catalogFieldset">
        <legend>Clase de activo</legend>
        <div className="catalogWeights">
          {ASSET_CLASS_LABELS.map(({ bucket, label }) => (
            <label key={bucket}>
              {label}
              <input
                inputMode="decimal"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    assetClass: { ...draft.assetClass, [bucket]: e.target.value },
                  })
                }
                placeholder="0"
                value={draft.assetClass[bucket] ?? ""}
              />
            </label>
          ))}
        </div>
        <CoverageMeter weights={pruneWeights(draft.assetClass)} />
      </fieldset>

      <fieldset className="catalogFieldset">
        <legend>Divisa subyacente</legend>
        {draft.currency.map((row) => (
          <div className="catalogCurrencyRow" key={row.id}>
            <input
              aria-label="Divisa ISO-4217"
              maxLength={3}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  currency: draft.currency.map((r) =>
                    r.id === row.id ? { ...r, code: e.target.value.toUpperCase() } : r,
                  ),
                })
              }
              placeholder="USD"
              value={row.code}
            />
            <input
              aria-label="Peso 0–1"
              inputMode="decimal"
              onChange={(e) =>
                setDraft({
                  ...draft,
                  currency: draft.currency.map((r) =>
                    r.id === row.id ? { ...r, weight: e.target.value } : r,
                  ),
                })
              }
              placeholder="0"
              value={row.weight}
            />
            <button
              className="btnSmall btnWarning"
              onClick={() =>
                setDraft({
                  ...draft,
                  currency: draft.currency.filter((r) => r.id !== row.id),
                })
              }
              type="button"
            >
              Quitar
            </button>
          </div>
        ))}
        <button
          className="btnSmall"
          onClick={() =>
            setDraft({
              ...draft,
              currency: [
                ...draft.currency,
                {
                  id: draft.currency.reduce((max, r) => Math.max(max, r.id), -1) + 1,
                  code: "",
                  weight: "",
                },
              ],
            })
          }
          type="button"
        >
          Añadir divisa
        </button>
        <CoverageMeter weights={currencyObject(draft.currency)} />
      </fieldset>

      {state.status === "error" ? (
        <p className="formError" role="alert">
          {state.message}
        </p>
      ) : null}

      <div className="rowActions">
        <button
          className="btn"
          disabled={pending || draftExceedsHundred(draft)}
          type="submit"
        >
          {isCreate ? "Crear perfil" : "Guardar cambios"}
        </button>
        {draftExceedsHundred(draft) ? (
          <span className="catalogOver">
            Alguna dimensión suma más del 100%; corrígela para guardar.
          </span>
        ) : null}
      </div>
    </form>
  );
}

interface RekeyFormProps {
  profile: GlobalExposureProfile;
  onResult: (result: CatalogActionResult) => void;
}

export function CatalogRekeyForm({ profile, onResult }: RekeyFormProps) {
  const [open, setOpen] = useState(false);
  const [isin, setIsin] = useState("");
  const [priceProvider, setPriceProvider] = useState("");
  const [providerSymbol, setProviderSymbol] = useState("");
  const [state, dispatch, pending] = useActionState(rekeyCatalogProfileAction, IDLE);
  useResultEffect(state, onResult);

  const from = identityFields(profile);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !window.confirm(
        "Rekey cambia la identidad del perfil (conserva su creación). ¿Continuar?",
      )
    ) {
      return;
    }
    startTransition(() => dispatch(new FormData(event.currentTarget)));
  }

  if (!open) {
    return (
      <div className="rowActions">
        <button className="btnSmall" onClick={() => setOpen(true)} type="button">
          Rekey (cambiar identidad)
        </button>
      </div>
    );
  }

  return (
    <form className="catalogForm stackForm catalogRekey" onSubmit={submit}>
      <input name="from-isin" type="hidden" value={from.isin} />
      <input name="from-priceProvider" type="hidden" value={from.priceProvider} />
      <input name="from-providerSymbol" type="hidden" value={from.providerSymbol} />
      <p className="catalogHint">
        Identidad actual: <strong>{identityText(profile.identity)}</strong>. Introduce la
        nueva identidad.
      </p>
      <label>
        Nuevo ISIN
        <input
          autoComplete="off"
          name="to-isin"
          onChange={(e) => setIsin(e.target.value)}
          placeholder="IE00B4L5Y983"
          value={isin}
        />
      </label>
      <div className="catalogTwoCol">
        <label>
          Proveedor
          <select
            name="to-priceProvider"
            onChange={(e) => setPriceProvider(e.target.value)}
            value={priceProvider}
          >
            <option value="">—</option>
            {PRICE_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </label>
        <label>
          Símbolo
          <input
            autoComplete="off"
            name="to-providerSymbol"
            onChange={(e) => setProviderSymbol(e.target.value)}
            value={providerSymbol}
          />
        </label>
      </div>
      {state.status === "error" ? (
        <p className="formError" role="alert">
          {state.message}
        </p>
      ) : null}
      <div className="rowActions">
        <button className="btn" disabled={pending} type="submit">
          Confirmar rekey
        </button>
        <button className="btnSmall" onClick={() => setOpen(false)} type="button">
          Cancelar
        </button>
      </div>
    </form>
  );
}

interface DeleteFormProps {
  profile: GlobalExposureProfile;
  onResult: (result: CatalogActionResult) => void;
}

export function CatalogDeleteForm({ profile, onResult }: DeleteFormProps) {
  const [state, dispatch, pending] = useActionState(deleteCatalogProfileAction, IDLE);
  useResultEffect(state, onResult);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !window.confirm(
        `Eliminar el perfil ${identityText(profile.identity)} del catálogo. Esta acción es física. ¿Continuar?`,
      )
    ) {
      return;
    }
    startTransition(() => dispatch(new FormData(event.currentTarget)));
  }

  return (
    <form className="catalogDelete" onSubmit={submit}>
      <IdentityHiddenFields profile={profile} />
      {state.status === "error" ? (
        <p className="formError" role="alert">
          {state.message}
        </p>
      ) : null}
      <button className="btnSmall btnWarning" disabled={pending} type="submit">
        Eliminar perfil
      </button>
    </form>
  );
}
