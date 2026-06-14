/**
 * PROTOTIPO #162 · Variante B — «Reparto por metal».
 * Dirección: la colección es una COMPOSICIÓN, no una lista. El detalle es una
 * tira 100 % apilada por metal + un ecualizador de barras altas descendentes
 * (la barra ES el contenido, no una decoración de 6px); las monedas viven
 * plegadas tras cada barra como lista mínima sin cabecera. Gestalt del trío:
 * A = filas · B = composición · C = fichas. Afordancia: comparar el TAMAÑO
 * relativo de cada metal de un vistazo. Conexión = tile de fuente conectada.
 *
 * Por qué barras y no donut: el donut chocaría con el del dashboard (el único
 * gráfico estrella de la app) — reintroduciría el mismo «no veo diferencia»; y
 * con datos tan sesgados (Oro ~82 %) una porción del 0,2 % es invisible,
 * mientras que un ecualizador descendente cuenta la verdad: «el oro lo sostiene».
 */

import {
  basisTag,
  coinCount,
  coinValue,
  coinsByMetal,
  COLLECTION_COIN_COUNT,
  COLLECTION_LAST_SYNC,
  COLLECTION_TOTAL_MINOR,
  eur,
  METAL_ORDER,
  METALS,
  metalSubtotalMinor,
  MOCK_COINS,
} from "./mock-collection";

const SIBLINGS = [
  { name: "Vivienda habitual", value: 285_000_00 },
  { name: "Oro físico (lingote 50 g)", value: 3_100_00 },
  { name: "Renault Clio (2018)", value: 6_500_00 },
];

const grouped = coinsByMetal(MOCK_COINS);
const presentMetals = METAL_ORDER.filter((m) => grouped[m].length > 0);

/** % suelo para que un metal mínimo (Bronce 0,2 %) siga viéndose. */
const MIN_SHARE = 2;

const shares = presentMetals.map((metal) => {
  const subtotal = metalSubtotalMinor(grouped[metal]);
  return { metal, subtotal, pct: (subtotal / COLLECTION_TOTAL_MINOR) * 100 };
});

/** Tira 100 %: suelo aplicado y RE-NORMALIZADO para que vuelva a sumar 100 %
 *  (con suelo, las anchuras crudas se pasarían de 100). Inexactitud asumida:
 *  es un prototipo y el oro sigue dominando visualmente. */
const flooredSum = shares.reduce((s, r) => s + Math.max(r.pct, MIN_SHARE), 0);
const stripSegs = shares.map((r) => ({
  metal: r.metal,
  width: (Math.max(r.pct, MIN_SHARE) / flooredSum) * 100,
  pct: r.pct,
}));

const pctLabel = (pct: number): string => (pct < 1 ? "<1 %" : `${Math.round(pct)} %`);

function CompositionStrip({ ariaHidden }: { ariaHidden?: boolean }) {
  return (
    <span
      className="np-stack"
      aria-hidden={ariaHidden ? "true" : undefined}
      role={ariaHidden ? undefined : "img"}
      aria-label={ariaHidden ? undefined : "Reparto por metal"}
    >
      {stripSegs.map((s) => (
        <i
          key={s.metal}
          style={{ flexBasis: `${s.width}%`, background: METALS[s.metal].tone }}
          title={`${METALS[s.metal].label} · ${pctLabel(s.pct)}`}
        />
      ))}
    </span>
  );
}

export default function VariantPanel() {
  const illiquidTotal =
    SIBLINGS.reduce((s, x) => s + x.value, 0) + COLLECTION_TOTAL_MINOR;

  return (
    <>
      {/* ── Superficie 1 — la línea en Patrimonio (con tira de reparto) ────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">
          Superficie 1 · La línea en Patrimonio — con tira de reparto
        </span>
        <section className="patrimonioSection" aria-label="Ilíquido">
          <div className="patrimonioSectionHeader">
            <h3>Ilíquido</h3>
            <strong>{eur(illiquidTotal)}</strong>
          </div>
          <div className="tableScroll">
            <table className="patrimonioTable">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Capa</th>
                  <th>Valor</th>
                  <th>Propiedad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {SIBLINGS.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>Ilíquido</td>
                    <td className="np-num">{eur(s.value)}</td>
                    <td>100%</td>
                    <td className="rowActions">
                      <span className="btnSmall">Editar</span>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    Colección Numista
                    {/* La tira 100 % lleva la COMPOSICIÓN a la propia lista —
                        única superficie 1 que codifica tamaño relativo (A = nota
                        de texto, C = puntos de igual tamaño). */}
                    <div>
                      <CompositionStrip ariaHidden />
                    </div>
                  </td>
                  <td>Ilíquido</td>
                  <td className="readOnlyValue np-num">
                    {eur(COLLECTION_TOTAL_MINOR)}
                    <small> Valor calculado</small>
                  </td>
                  <td>100%</td>
                  <td className="rowActions">
                    <span className="btnSmall">Ver detalle</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>

      {/* ── Superficie 2 — composición por metal (tira + ecualizador) ──────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">
          Superficie 2 · Detalle de la colección — composición por metal
        </span>
        <section className="patrimonioSection" aria-label="Composición por metal">
          <div className="patrimonioSectionHeader">
            <h3>Colección Numista · {COLLECTION_COIN_COUNT} monedas</h3>
            <strong>{eur(COLLECTION_TOTAL_MINOR)}</strong>
          </div>
          <div style={{ padding: "0.4rem 0.2rem 0.2rem" }}>
            {/* Tira 100 % apilada — el reparto de un vistazo. */}
            <span className="np-compStrip" role="img" aria-label="Reparto por metal">
              {stripSegs.map((s) => (
                <i
                  key={s.metal}
                  style={{ flexBasis: `${s.width}%`, background: METALS[s.metal].tone }}
                  title={`${METALS[s.metal].label} · ${pctLabel(s.pct)}`}
                />
              ))}
            </span>

            {/* Ecualizador: una barra alta por metal, descendente. Cada fila es
                el <summary> de un <details> CERRADO; al abrir, lista mínima. */}
            {shares.map((r) => {
              const coins = grouped[r.metal];
              return (
                <details
                  className="np-propRow"
                  key={r.metal}
                  style={{ ["--np-tone" as string]: METALS[r.metal].tone }}
                >
                  <summary>
                    <span className="np-propLabel">
                      {METALS[r.metal].label}
                      <small>· {coins.length} pos.</small>
                    </span>
                    <span className="np-propBar" aria-hidden="true">
                      <i style={{ width: `${Math.max(r.pct, MIN_SHARE)}%` }} />
                      <b className="np-propPct">{pctLabel(r.pct)}</b>
                    </span>
                    <span className="np-propVal np-num">
                      {eur(r.subtotal)}
                      <small>{coinCount(coins)} monedas</small>
                    </span>
                  </summary>
                  <div className="np-coinList">
                    {coins.map((coin) => {
                      const v = coinValue(coin);
                      const tag = basisTag(v.basis);
                      return (
                        <div className="np-coinLine" key={coin.id}>
                          <span>
                            {coin.name}{" "}
                            <small>
                              · {coin.grade} · {coin.year}
                            </small>
                          </span>
                          <span className="np-num">×{coin.quantity}</span>
                          <span className="np-coinAmt np-num">
                            <strong>{eur(v.minor)}</strong>
                            <span className={`np-tag ${tag.cls}`}>{tag.label}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      </section>

      {/* ── Superficie 3 — tile de fuente conectada ───────────────────────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">Superficie 3 · Fuente conectada</span>
        <div className="np-card">
          <div className="np-statusGrid">
            <div>
              <span className="np-statusPill">Conectado</span>
              <div className="np-statusStats">
                <div>
                  <span>Última sync</span>
                  <b>{COLLECTION_LAST_SYNC}</b>
                </div>
                <div>
                  <span>Monedas</span>
                  <b className="np-num">{COLLECTION_COIN_COUNT}</b>
                </div>
                <div>
                  <span>Valor</span>
                  <b className="np-num">{eur(COLLECTION_TOTAL_MINOR)}</b>
                </div>
              </div>
            </div>
            <button className="np-btnPrimary" type="button">
              Sincronizar
            </button>
          </div>
          <details style={{ marginTop: "1rem" }}>
            <summary style={{ cursor: "pointer", color: "var(--blue)" }}>
              Credenciales
            </summary>
            <form style={{ marginTop: "0.8rem" }}>
              <div className="np-fieldRow" style={{ marginBottom: "0.7rem" }}>
                <label className="np-field">
                  <span>Clave de API</span>
                  <input placeholder="xxxxxxxx…" type="text" />
                </label>
                <label className="np-field">
                  <span>Client ID</span>
                  <input placeholder="123456" type="text" />
                </label>
                <label className="np-field">
                  <span>Client secret</span>
                  <input placeholder="••••••••" type="password" />
                </label>
              </div>
              <button className="np-btnOutline" type="button">
                Guardar credenciales
              </button>
            </form>
          </details>
        </div>
      </section>
    </>
  );
}
