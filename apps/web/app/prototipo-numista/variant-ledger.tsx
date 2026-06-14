/**
 * PROTOTIPO #162 · Variante A — «Libro mayor».
 * Dirección: la colección es UNA fila más del Patrimonio. Todo son tablas y
 * filas densas, idénticas al resto de la app; el detalle agrupa por metal con
 * secciones plegables tipo «tier». Afordancia principal: escanear el ledger.
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

function CoinTable({ coins }: { coins: MockCoin[] }) {
  return (
    <div className="tableScroll np-metalCoins">
      <table className="patrimonioTable">
        <thead>
          <tr>
            <th>Moneda</th>
            <th>Grado</th>
            <th>Cant.</th>
            <th>Metal</th>
            <th>Numism.</th>
            <th>Valor</th>
          </tr>
        </thead>
        <tbody>
          {coins.map((coin) => {
            const v = coinValue(coin);
            const tag = basisTag(v.basis);
            return (
              <tr key={coin.id}>
                <td>
                  {coin.name}{" "}
                  <small style={{ color: "var(--muted)" }}>
                    · {coin.country} {coin.year}
                  </small>
                </td>
                <td>{coin.grade}</td>
                <td className="np-num">{coin.quantity}</td>
                <td className={`np-num ${v.basis === "metal" ? "" : "np-alt"}`}>
                  {coin.metalMinor > 0 ? eur(coin.metalMinor) : "—"}
                </td>
                <td className={`np-num ${v.basis === "coleccion" ? "" : "np-alt"}`}>
                  {coin.numismaticMinor > 0 ? eur(coin.numismaticMinor) : "—"}
                </td>
                <td className="np-num">
                  <strong>{eur(v.minor)}</strong>
                  <span className={`np-tag ${tag.cls}`}>{tag.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function VariantLedger() {
  const illiquidTotal =
    SIBLINGS.reduce((s, x) => s + x.value, 0) + COLLECTION_TOTAL_MINOR;

  return (
    <>
      {/* ── Superficie 1 — la línea en Patrimonio ─────────────────────────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">Superficie 1 · La línea en Patrimonio</span>
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
                {/* La fila de la colección: idéntica forma, marcada como derivada
                    y con una nota de sync en línea — nada de cromo extra. */}
                <tr>
                  <td>
                    Colección Numista
                    <div style={{ color: "var(--muted)", fontSize: "0.74rem" }}>
                      ⟳ Sincronizada {COLLECTION_LAST_SYNC}
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

      {/* ── Superficie 2 — detalle del catálogo agrupado por metal ────────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">
          Superficie 2 · Detalle de la colección — agrupado por metal
        </span>
        <section className="patrimonioSection" aria-label="Colección Numista">
          <div className="patrimonioSectionHeader">
            <h3>Colección Numista · {COLLECTION_COIN_COUNT} monedas</h3>
            <strong>{eur(COLLECTION_TOTAL_MINOR)}</strong>
          </div>
          <div style={{ padding: "0 0.2rem" }}>
            {METAL_ORDER.map((metal) => {
              const coins = grouped[metal];
              if (coins.length === 0) return null;
              const subtotal = metalSubtotalMinor(coins);
              const pct = (subtotal / COLLECTION_TOTAL_MINOR) * 100;
              const pctLabel = pct < 1 ? "<1 %" : `${Math.round(pct)} %`;
              return (
                <details
                  className="np-metal"
                  key={metal}
                  open={metal === "oro" || metal === "plata"}
                  style={{ ["--np-tone" as string]: METALS[metal].tone }}
                >
                  <summary>
                    <span className="np-metalName">
                      {METALS[metal].label}
                      <small>· {coins.length} posiciones</small>
                    </span>
                    <b>{eur(subtotal)}</b>
                    <span className="np-metalShare">{pctLabel}</span>
                    <span className="np-metalBar" aria-hidden="true">
                      <i style={{ width: `${Math.max(pct, 1.5)}%` }} />
                    </span>
                  </summary>
                  <CoinTable coins={coins} />
                </details>
              );
            })}
          </div>
        </section>
      </section>

      {/* ── Superficie 3 — conectar / sincronizar ─────────────────────────── */}
      <section className="np-surface">
        <span className="np-surfaceLabel">Superficie 3 · Conectar y sincronizar</span>
        <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "1fr 1fr" }}>
          <div className="np-card">
            <p style={{ marginTop: 0, fontWeight: 650 }}>Sin conectar</p>
            <form>
              <label className="np-field">
                <span>Clave de API de Numista</span>
                <input placeholder="xxxxxxxx…" type="text" />
              </label>
              <label className="np-field">
                <span>OAuth client ID</span>
                <input placeholder="123456" type="text" />
              </label>
              <label className="np-field">
                <span>OAuth client secret</span>
                <input placeholder="••••••••" type="password" />
              </label>
              <button className="np-btnPrimary" type="button">
                Conectar Numista
              </button>
            </form>
          </div>
          <div className="np-card">
            <p style={{ marginTop: 0, fontWeight: 650 }}>Conectado</p>
            <div className="np-syncLine">
              <span>
                Última sincronización: {COLLECTION_LAST_SYNC} · {COLLECTION_COIN_COUNT}{" "}
                monedas
              </span>
            </div>
            <div style={{ marginTop: "0.9rem", display: "flex", gap: "0.7rem" }}>
              <button className="np-btnOutline" type="button">
                Sincronizar ahora
              </button>
              <button className="np-btnOutline" type="button">
                Desconectar
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
