import { runBootstrapHealthcheck } from "@worthline/db";
import { createDashboardShell, formatMoneyMinor } from "@worthline/domain";

export const dynamic = "force-dynamic";

const statusTone = {
  empty: "Pendiente",
  ready: "Activo",
} as const;

export default function DashboardPage() {
  const persistence = runBootstrapHealthcheck();
  const dashboard = createDashboardShell({ persistence });

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1>worthline</h1>
            <p>Patrimonio neto local</p>
          </div>
        </div>
        <div className="topbarMeta" aria-label="Estado de persistencia">
          <span className="statusDot" aria-hidden="true" />
          SQLite OK
        </div>
      </header>

      <section className="summaryBand" aria-label="Resumen patrimonial">
        <div className="scopeRail">
          <span>Hogar</span>
          <span>EUR</span>
          <span>{new Date(dashboard.generatedAt).toLocaleString("es-ES")}</span>
        </div>
        <div className="metricsGrid">
          {dashboard.metrics.map((metric) => (
            <article className={`metricTile ${metric.posture}`} key={metric.id}>
              <span>{metric.label}</span>
              <strong>{formatMoneyMinor(metric.value)}</strong>
            </article>
          ))}
        </div>
      </section>

      <div className="mainGrid">
        <section className="ledgerPanel" aria-label="Modulos del producto">
          <div className="panelHeader">
            <h2>Linea operativa</h2>
            <span>Bootstrap</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Modulo</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.modules.map((module) => (
                <tr key={module.id}>
                  <td>{module.label}</td>
                  <td>
                    <span className={`statePill ${module.state}`}>
                      {statusTone[module.state]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="liquidityPanel" aria-label="Piramide de liquidez">
          <div className="panelHeader">
            <h2>Liquidez</h2>
            <span>Neto por capa</span>
          </div>
          <div className="pyramid">
            <div className="tier housing">
              <span>Vivienda</span>
              <b>0%</b>
            </div>
            <div className="tier locked">
              <span>Jubilacion</span>
              <b>0%</b>
            </div>
            <div className="tier market">
              <span>Mercado</span>
              <b>0%</b>
            </div>
            <div className="tier cash">
              <span>Caja</span>
              <b>0%</b>
            </div>
          </div>
        </section>
      </div>

      <footer className="persistenceBar">
        <span>{dashboard.persistence.displayPath}</span>
        <code>{dashboard.persistence.checkKey}</code>
      </footer>
    </main>
  );
}
