"use client";

import { useMemo, useState } from "react";

import styles from "./prototype.module.css";

type Bucket = "matched" | "new" | "ignored";
type LookupState = "matched" | "found" | "unresolved" | "ignored";

interface StatementRow {
  amountMinor: number;
  date: string;
  isin: string;
  status: string;
  units: number;
}

interface FundConfig {
  bucket: Bucket;
  includeByDefault: boolean;
  lookupState: LookupState;
  mergeFacts: string[];
  name: string;
  reason: string;
  symbol: string;
}

interface FundPreview extends FundConfig {
  amountMinor: number;
  executedRows: StatementRow[];
  isin: string;
  skippedRows: StatementRow[];
  totalRows: number;
  units: number;
}

const SYNTHETIC_MYINVESTOR_FILE = [
  "Fecha de la orden;ISIN;Importe estimado;Numero de participaciones;Estado",
  "05/01/2026;ES00WL000001;1200,00;34,2857;Ejecutada",
  "05/02/2026;ES00WL000001;1200,00;33,9120;Ejecutada",
  "05/03/2026;ES00WL000001;1200,00;33,5012;Pendiente",
  "10/01/2026;LU00WL000002;600,00;12,3456;Ejecutada",
  "10/02/2026;LU00WL000002;600,00;12,4011;Ejecutada",
  "15/01/2026;IE00WL000003;900,00;21,0000;Ejecutada",
  "15/02/2026;IE00WL000003;900,00;20,7500;Ejecutada",
  "20/01/2026;FR00WL000004;300,00;6,0000;Ejecutada",
  "20/02/2026;FR00WL000004;300,00;6,0600;Rechazada",
  "25/01/2026;NL00WL000005;450,00;9,0100;Ejecutada",
].join("\r\n");

const FUND_ORDER = [
  "ES00WL000001",
  "LU00WL000002",
  "IE00WL000003",
  "FR00WL000004",
  "NL00WL000005",
] as const;

const FUND_CONFIG: Record<(typeof FUND_ORDER)[number], FundConfig> = {
  ES00WL000001: {
    bucket: "matched",
    includeByDefault: true,
    lookupState: "matched",
    mergeFacts: [
      "05/01/2026 ya existe: el extracto sobrescribe importe y participaciones.",
      "05/02/2026 no existe: se añade como nueva operación.",
      "05/03/2026 queda fuera porque el estado es Pendiente.",
    ],
    name: "Fondo Aurora Global FI",
    reason: "ISIN encontrado en una inversión existente.",
    symbol: "AURORA.FAKE",
  },
  LU00WL000002: {
    bucket: "new",
    includeByDefault: true,
    lookupState: "found",
    mergeFacts: [
      "La búsqueda FAKE de ISIN devuelve nombre y símbolo.",
      "Se crearía una inversión de mercado con 100% del miembro conectado.",
      "Las 2 órdenes ejecutadas entrarían como operaciones iniciales.",
    ],
    name: "Fondo Brújula Europa FI",
    reason: "No existe en cartera; lookup resuelto.",
    symbol: "BRUJULA.FAKE",
  },
  IE00WL000003: {
    bucket: "new",
    includeByDefault: true,
    lookupState: "found",
    mergeFacts: [
      "La búsqueda FAKE prellena la ficha editable.",
      "Confirmar crea el holding y carga sus 2 operaciones.",
      "Reimportar el mismo fichero debería convertirse en no-op por fecha.",
    ],
    name: "ETF Puerto Pacífico",
    reason: "No existe en cartera; lookup resuelto.",
    symbol: "PUERTO.FAKE",
  },
  FR00WL000004: {
    bucket: "new",
    includeByDefault: false,
    lookupState: "unresolved",
    mergeFacts: [
      "La búsqueda FAKE no encuentra nombre ni símbolo.",
      "Puede dejarse excluido y confirmar el resto.",
      "Si se incluye sin símbolo, nacería con aviso MISSING_PROVIDER_SYMBOL.",
      "20/02/2026 queda fuera porque el estado es Rechazada.",
    ],
    name: "",
    reason: "Lookup sin resolver; no bloquea los demás fondos.",
    symbol: "",
  },
  NL00WL000005: {
    bucket: "ignored",
    includeByDefault: false,
    lookupState: "ignored",
    mergeFacts: [
      "El usuario lo deja fuera de esta importación.",
      "Sus filas siguen visibles para que la exclusión sea auditable.",
      "Confirmar no crea holding ni operaciones para este ISIN.",
    ],
    name: "Fondo Satélite Liquidez",
    reason: "Excluido por decisión del usuario.",
    symbol: "SATELITE.FAKE",
  },
};

const BUCKET_LABELS: Record<Bucket, string> = {
  ignored: "Ignorado",
  matched: "Encaja",
  new: "Nuevo",
};

const BUCKET_TONES: Record<Bucket, string> = {
  ignored: "excluded",
  matched: "matched",
  new: "created",
};

const FIXTURE_LINES = SYNTHETIC_MYINVESTOR_FILE.split("\r\n");
const FUNDS = buildFundPreviews(parseSyntheticFile(SYNTHETIC_MYINVESTOR_FILE));

const INITIAL_INCLUDED = Object.fromEntries(
  FUNDS.map((fund) => [fund.isin, fund.includeByDefault]),
) as Record<string, boolean>;

function parseDecimal(value: string): number {
  return Number(value.replace(".", "").replace(",", "."));
}

function parseSyntheticFile(file: string): StatementRow[] {
  const [, ...lines] = file.split("\r\n");

  return lines.map((line) => {
    const parts = line.split(";");

    if (parts.length !== 5) {
      throw new Error("Fixture sintética de extracto con columnas inválidas");
    }

    const [date, isin, amount, units, status] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];

    return {
      amountMinor: Math.round(parseDecimal(amount) * 100),
      date,
      isin,
      status,
      units: parseDecimal(units),
    };
  });
}

function buildFundPreviews(rows: StatementRow[]): FundPreview[] {
  return FUND_ORDER.map((isin) => {
    const fundRows = rows.filter((row) => row.isin === isin);
    const executedRows = fundRows.filter((row) => row.status === "Ejecutada");
    const skippedRows = fundRows.filter((row) => row.status !== "Ejecutada");

    return {
      ...FUND_CONFIG[isin],
      amountMinor: executedRows.reduce((total, row) => total + row.amountMinor, 0),
      executedRows,
      isin,
      skippedRows,
      totalRows: fundRows.length,
      units: executedRows.reduce((total, row) => total + row.units, 0),
    };
  });
}

function formatMoney(amountMinor: number): string {
  return new Intl.NumberFormat("es-ES", {
    currency: "EUR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(amountMinor / 100);
}

function formatUnits(units: number): string {
  return new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
  }).format(units);
}

export default function MultiIsinStatementPrototype() {
  const [includedByIsin, setIncludedByIsin] =
    useState<Record<string, boolean>>(INITIAL_INCLUDED);

  const summary = useMemo(() => {
    const includedFunds = FUNDS.filter((fund) => includedByIsin[fund.isin]);
    const excludedFunds = FUNDS.filter((fund) => !includedByIsin[fund.isin]);

    return {
      amountMinor: includedFunds.reduce((total, fund) => total + fund.amountMinor, 0),
      createdCount: includedFunds.filter((fund) => fund.bucket === "new").length,
      excludedCount: excludedFunds.length,
      executedRows: includedFunds.reduce(
        (total, fund) => total + fund.executedRows.length,
        0,
      ),
      fundCount: includedFunds.length,
      matchedCount: includedFunds.filter((fund) => fund.bucket === "matched").length,
      unresolvedCount: includedFunds.filter((fund) => fund.lookupState === "unresolved")
        .length,
    };
  }, [includedByIsin]);

  const bucketStats = (["matched", "new", "ignored"] as const).map((bucket) => ({
    amountMinor: FUNDS.filter((fund) => fund.bucket === bucket).reduce(
      (total, fund) => total + fund.amountMinor,
      0,
    ),
    bucket,
    funds: FUNDS.filter((fund) => fund.bucket === bucket).length,
    rows: FUNDS.filter((fund) => fund.bucket === bucket).reduce(
      (total, fund) => total + fund.executedRows.length,
      0,
    ),
  }));

  const toggleIncluded = (isin: string) => {
    setIncludedByIsin((current) => ({
      ...current,
      [isin]: !current[isin],
    }));
  };

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span aria-hidden="true" className={styles.brandMark}>
            wl
          </span>
          <div>
            <p>Prototipo S0</p>
            <h1>Preview de extracto multi-ISIN</h1>
          </div>
        </div>
        <a className={styles.backLink} href="/patrimonio">
          Volver a patrimonio
        </a>
      </header>

      <section className={styles.heroGrid} aria-labelledby="prototype-title">
        <div className={styles.heroPanel}>
          <p className={styles.eyebrow}>Fichero sintético · MyInvestor Órdenes</p>
          <h2 id="prototype-title">Un solo extracto, cinco ISINs, una decisión.</h2>
          <p>
            La pantalla agrupa el fichero por ISIN, separa lo que encaja con cartera, lo
            que puede crearse con búsqueda FAKE y lo que queda fuera. No hay datos reales
            de broker en este prototipo.
          </p>
          <div className={styles.fixtureMeta} aria-label="Forma del fichero">
            <span>CRLF</span>
            <span>dd/mm/yyyy</span>
            <span>coma decimal</span>
            <span>semicolon CSV</span>
          </div>
        </div>

        <aside className={styles.summaryPanel} aria-label="Resumen de confirmación">
          <p className={styles.eyebrow}>Confirmar selección</p>
          <div className={styles.summaryFigure}>{formatMoney(summary.amountMinor)}</div>
          <dl className={styles.summaryList}>
            <div>
              <dt>Fondos incluidos</dt>
              <dd>{summary.fundCount}</dd>
            </div>
            <div>
              <dt>Operaciones</dt>
              <dd>{summary.executedRows}</dd>
            </div>
            <div>
              <dt>Encajan</dt>
              <dd>{summary.matchedCount}</dd>
            </div>
            <div>
              <dt>Nuevos</dt>
              <dd>{summary.createdCount}</dd>
            </div>
          </dl>
          {summary.unresolvedCount > 0 ? (
            <p className={styles.warningText}>
              {summary.unresolvedCount} fondo incluido sin símbolo: nacería con aviso
              MISSING_PROVIDER_SYMBOL.
            </p>
          ) : (
            <p className={styles.mutedText}>
              {summary.excludedCount} fondos quedan fuera; el resto puede confirmarse
              all-or-nothing.
            </p>
          )}
          <button className={styles.primaryButton} type="button">
            Confirmar {summary.fundCount} fondos
          </button>
        </aside>
      </section>

      <section className={styles.bucketGrid} aria-label="Conteo por bucket">
        {bucketStats.map((stat) => (
          <article className={styles.bucketCard} key={stat.bucket}>
            <p className={styles.eyebrow}>{BUCKET_LABELS[stat.bucket]}</p>
            <strong>{stat.funds} fondos</strong>
            <span>
              {stat.rows} operaciones · {formatMoney(stat.amountMinor)}
            </span>
          </article>
        ))}
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.fixturePanel} aria-labelledby="fixture-title">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>Fixture sintética</p>
              <h2 id="fixture-title">Texto del fichero</h2>
            </div>
            <span>{FIXTURE_LINES.length - 1} órdenes</span>
          </div>
          <pre className={styles.fixtureCode} aria-label="Contenido del CSV sintético">
            {FIXTURE_LINES.map((line, index) => (
              <code key={line}>
                {line}
                {index < FIXTURE_LINES.length - 1 ? "␍␊\n" : ""}
              </code>
            ))}
          </pre>
        </article>

        <article className={styles.tablePanel} aria-labelledby="preview-title">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>Preview agrupada</p>
              <h2 id="preview-title">Fondos detectados</h2>
            </div>
            <span>Densidad compacta</span>
          </div>

          <div className={styles.tableScroll}>
            <table className={styles.previewTable}>
              <caption>
                Cada fila es un ISIN. El detalle de merge se abre dentro de la fila.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Incluir</th>
                  <th scope="col">Bucket</th>
                  <th scope="col">ISIN</th>
                  <th scope="col">Inversión / lookup</th>
                  <th scope="col">Órdenes</th>
                  <th scope="col">Importe</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {FUNDS.map((fund) => {
                  const included = includedByIsin[fund.isin];
                  const investmentLabel =
                    fund.lookupState === "unresolved" ? "Lookup sin resolver" : fund.name;

                  return (
                    <tr
                      className={included ? styles.includedRow : styles.excludedRow}
                      key={fund.isin}
                    >
                      <td>
                        <label className={styles.checkboxLabel}>
                          <input
                            checked={included}
                            onChange={() => toggleIncluded(fund.isin)}
                            type="checkbox"
                          />
                          <span>{included ? "Sí" : "No"}</span>
                        </label>
                      </td>
                      <td>
                        <span
                          className={`${styles.bucketPill} ${
                            styles[BUCKET_TONES[fund.bucket]]
                          }`}
                        >
                          {BUCKET_LABELS[fund.bucket]}
                        </span>
                      </td>
                      <td>
                        <code className={styles.isinCode}>{fund.isin}</code>
                      </td>
                      <td>
                        <strong>{investmentLabel}</strong>
                        <span className={styles.rowHint}>
                          {fund.symbol || "nombre y símbolo editables en blanco"}
                        </span>
                      </td>
                      <td>
                        <strong>{fund.executedRows.length}</strong>
                        <span className={styles.rowHint}>
                          {fund.skippedRows.length > 0
                            ? `${fund.skippedRows.length} saltada`
                            : `${fund.totalRows} en fichero`}
                        </span>
                      </td>
                      <td>
                        <strong>{formatMoney(fund.amountMinor)}</strong>
                        <span className={styles.rowHint}>
                          {formatUnits(fund.units)} participaciones
                        </span>
                      </td>
                      <td>
                        <details className={styles.mergeDetails}>
                          <summary>Ver merge</summary>
                          <p>{fund.reason}</p>
                          <ul>
                            {fund.mergeFacts.map((fact) => (
                              <li key={fact}>{fact}</li>
                            ))}
                          </ul>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </main>
  );
}
