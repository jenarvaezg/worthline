/**
 * PROTOTIPO #162 · Variante C — «Galería numismática».
 * Dirección: las monedas son objetos. El detalle es una rejilla de fichas
 * agrupadas por bandas de metal; cada ficha enseña el valor ganador grande y el
 * perdedor tachado. Afordancia principal: ojear la colección. Conexión guiada
 * en dos pasos.
 */

import {
  basisTag,
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
  type MockCoin,
} from "./mock-collection";

const SIBLINGS = [
  { name: "Vivienda habitual", value: 285_000_00 },
  { name: "Oro físico (lingote 50 g)", value: 3_100_00 },
  { name: "Renault Clio (2018)", value: 6_500_00 },
];

const grouped = coinsByMetal(MOCK_COINS);

/** Metales presentes en la colección, para los puntos-resumen de la fila. */
const presentMetals = METAL_ORDER.filter((m) => grouped[m].length > 0);

function CoinTile({ coin }: { coin: MockCoin }) {
  const v = coinValue(coin);
  const tag = basisTag(v.basis);
  // El «perdedor»: la candidata que NO ganó el max(), tachada para hacer
  // visible la regla de valoración por moneda.
  const loserMinor =
    v.basis === "metal"
      ? coin.numismaticMinor
      : v.basis === "coleccion"
        ? coin.metalMinor
        : 0;
  return (
    <div className="np-coin" style={{ ["--np-tone" as string]: METALS[coin.metal].tone }}>
      <div className="np-coinName">{coin.name}</div>
      <div className="np-coinMeta">
        {coin.country} · {coin.year}
      </div>
      <div className="np-coinValue np-num">{eur(v.minor)}</div>
      <div className="np-coinAlt">
        {loserMinor > 0 ? (
          <span className="np-alt np-num">{eur(loserMinor)}</span>
        ) : (
          <span className={`np-tag ${tag.cls}`}>{tag.label}</span>
        )}
        {loserMinor > 0 ? <span className={`np-tag ${tag.cls}`}>{tag.label}</span> : null}
      </div>
      <div className="np-coinFoot">
        <span className="np-gradeChip">{coin.grade}</span>
        <span className="np-coinQty">×{coin.quantity}</span>
      </div>
    </div>
  );
}

export default function VariantGallery() {
  const illiquidTotal =
    SIBLINGS.reduce((s, x) => s + x.value, 0) + COLLECTION_TOTAL_MINOR;

  return (
    <>
      {/* ── Superficie 1 — la línea en Patrimonio (con puntos de metal) ───── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">
          Superficie 1 · La línea en Patrimonio — con puntos de metal
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
                    <span className="np-swatches" aria-hidden="true">
                      {presentMetals.map((m) => (
                        <span
                          className="np-swatch"
                          key={m}
                          style={{ background: METALS[m].tone }}
                          title={METALS[m].label}
                        />
                      ))}
                    </span>
                  </td>
                  <td>Ilíquido</td>
                  <td className="readOnlyValue np-num">
                    {eur(COLLECTION_TOTAL_MINOR)}
                    <small> Valor calculado</small>
                  </td>
                  <td>100%</td>
                  <td className="rowActions">
                    <span className="btnSmall">Ver colección</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>

      {/* ── Superficie 2 — galería de fichas por banda de metal ───────────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">
          Superficie 2 · Detalle de la colección — galería por metal
        </span>
        <section className="patrimonioSection" aria-label="Colección Numista">
          <div className="patrimonioSectionHeader">
            <h3>Colección Numista · {COLLECTION_COIN_COUNT} monedas</h3>
            <strong>{eur(COLLECTION_TOTAL_MINOR)}</strong>
          </div>
          <div style={{ padding: "0 0.2rem 0.4rem" }}>
            {METAL_ORDER.map((metal) => {
              const coins = grouped[metal];
              if (coins.length === 0) return null;
              return (
                <div key={metal} style={{ ["--np-tone" as string]: METALS[metal].tone }}>
                  <div className="np-band">
                    <h4>{METALS[metal].label}</h4>
                    <span className="np-bandCount">{coins.length} posiciones</span>
                    <span className="np-bandTotal np-num">
                      {eur(metalSubtotalMinor(coins))}
                    </span>
                  </div>
                  <div className="np-grid">
                    {coins.map((coin) => (
                      <CoinTile coin={coin} key={coin.id} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </section>

      {/* ── Superficie 3 — conexión guiada en dos pasos ───────────────────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">Superficie 3 · Conectar en dos pasos</span>
        <div className="np-card">
          <div className="np-steps">
            <div className="np-step">
              <div className="np-stepNum">1</div>
              <div className="np-stepBody">
                <h4>Pega tus credenciales de Numista</h4>
                <form>
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
                  <details>
                    <summary style={{ cursor: "pointer", color: "var(--blue)" }}>
                      ¿De dónde saco estas credenciales?
                    </summary>
                    <p className="np-dim" style={{ marginBottom: 0 }}>
                      Registra una app propia en Numista (Cuenta → API) y copia su clave y
                      el par OAuth. worthline las guarda solo en tu configuración local;
                      nunca se exportan.
                    </p>
                  </details>
                </form>
              </div>
            </div>
            <div className="np-step">
              <div className="np-stepNum">2</div>
              <div className="np-stepBody">
                <h4>Sincroniza tu colección</h4>
                <p className="np-dim" style={{ marginTop: 0 }}>
                  Traemos tus monedas en modo solo lectura. Última sincronización:{" "}
                  {COLLECTION_LAST_SYNC} · {COLLECTION_COIN_COUNT} monedas.
                </p>
                <button className="np-btnPrimary" type="button">
                  Sincronizar Numista
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
