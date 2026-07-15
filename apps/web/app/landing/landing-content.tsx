import { THIRD_PARTY_AI_NOTICE_TEXT } from "@web/asistente/third-party-ai-notice";
import type { CSSProperties } from "react";
import { heroSheetData } from "./hero-sheet/build-hero-sheet";
import styles from "./landing.module.css";
import LandingExperience from "./landing-experience";

/**
 * Landing pública «Evoluciona tu Excel» (#951, PRD #877): las 9 secciones del
 * content outline (#860) con el copy aprobado, en el registro visual de
 * cubierta de «La cubierta y las páginas» (#862). La sección 2 del outline
 * (la prueba visual) vive absorbida en la hoja encartada del hero — decisión
 * de la crítica adversaria de #862.
 *
 * Íntegra sin JS: todo se sirve en su estado final. La hoja del hero ya NO es
 * maqueta (S4, #952): sus cifras son datos reales de la persona demo «Familia»,
 * resueltos en build por el motor y horneados en el HTML estático — la aritmética
 * cuadra (bruto − deuda = neto) por construcción, no a mano. Ver
 * `./hero-sheet/build-hero-sheet` para por qué eso no rompe la invariante
 * estática (siembra en memoria solo en build, cero lecturas de DB por visita).
 * S5 (#953) añade una única isla progresiva en el masthead: resuelve la sesión
 * en cliente y orquesta este mismo DOM; sin JS permanece íntegro y ofrece Entrar.
 */

function DemoLink({ label = "Velo en la demo" }: { label?: string }) {
  return (
    <a className={styles.demolink} href="/demo">
      {label} <span className={styles.arr}>→</span>
    </a>
  );
}

function Ctas({ coverStage }: { coverStage?: number } = {}) {
  return (
    <div
      className={
        coverStage === undefined ? styles.ctas : `${styles.ctas} ${styles.stage}`
      }
      data-cover-stage={coverStage}
    >
      <a className={`${styles.btn} ${styles.btnPaper}`} href="/login?returnTo=/app">
        Empezar con mis datos
      </a>
      <a className={`${styles.btn} ${styles.btnOutline}`} href="/demo">
        Explorar la demo
      </a>
    </div>
  );
}

function Cover() {
  return (
    <div className={styles.cover} id="top">
      <div className={styles.grain} aria-hidden="true" />
      <div className={styles.spine} aria-hidden="true">
        <span>worthline · libro mayor de tu patrimonio · mmxxvi</span>
      </div>
      <div className={`${styles.ghost} ${styles.num}`} aria-hidden="true">
        {heroSheetData.netGhost}
      </div>
      <div className={styles.wrap}>
        <header className={`${styles.masthead} ${styles.stage}`} data-cover-stage="0">
          <a className={styles.wordmark} href="#top">
            worthline
          </a>
          <span className={styles.spacer} />
          <a href="/demo">Explorar la demo</a>
          <LandingExperience
            netFinal={heroSheetData.netLabel}
            netTarget={Math.round(heroSheetData.netMinor / 100)}
            sessionClassName={styles.session}
            sessionPlaceholderClassName={styles.sessionPlaceholder}
            sessionSlotClassName={styles.sessionSlot}
          />
        </header>

        <div className={styles.coverGrid}>
          <div>
            <p className={`${styles.eyebrow} ${styles.stage}`} data-cover-stage="1">
              El libro mayor de tu patrimonio
            </p>
            <h1 className={styles.stage} data-cover-stage="2">
              Evoluciona tu Excel<span className={styles.dot}>.</span>
            </h1>
            <p className={`${styles.lede} ${styles.stage}`} data-cover-stage="3">
              Todo tu patrimonio — activos, deudas, retornos reales, FIRE — por fin{" "}
              <strong>en una sola imagen</strong>. Cerrada, auditable y tuya.
            </p>
            <Ctas coverStage={4} />
          </div>

          <HeroSheet />
        </div>

        <p className={`${styles.scrollCue} ${styles.stage}`} data-cover-stage="6">
          <a href="#paginas">▾ Abre el libro</a>
        </p>
      </div>
    </div>
  );
}

/**
 * Sección 2 del outline: la prueba visual, encartada en la cubierta. Sus cifras
 * son datos reales de la persona demo, resueltos en build (#952) — ver
 * {@link heroSheetData}.
 */
function HeroSheet() {
  const { composition, rows, sparkline } = heroSheetData;
  const compLabel = `Composición del bruto: ${composition
    .map((seg) => seg.label.toLowerCase())
    .join(", ")}`;

  return (
    <figure className={`${styles.sheetFigure} ${styles.stage}`} data-cover-stage="5">
      <span className={styles.marginalia} aria-hidden="true">
        {heroSheetData.closedLabel} — nada se recalcula
      </span>
      <div className={styles.sheet}>
        <div className={styles.sheetTop}>
          <div className={styles.heroFigure}>
            <span className={styles.label}>Neto total</span>
            <span className={styles.figWrap} data-net-final={heroSheetData.netLabel}>
              <span className={styles.num} data-net-figure="">
                {heroSheetData.netLabel}
              </span>
              <span className={styles.dblrule} data-net-rule="" />
            </span>
          </div>
          <div className={styles.sheetRight}>
            <span className={styles.folio}>{heroSheetData.folioLabel}</span>
            <br />
            <span className={`${styles.delta} ${styles.num}`}>
              {heroSheetData.deltaLabel}
            </span>
          </div>
        </div>

        <div className={styles.sparkWrap}>
          <div className={styles.cap}>
            <span>Últimos 12 cierres</span>
            <span className={styles.num}>{heroSheetData.sparkCaption}</span>
          </div>
          <div className={styles.sparkClip} data-net-spark="">
            <svg
              className={styles.spark}
              viewBox="0 0 300 46"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polyline
                points={sparkline.points}
                fill="none"
                stroke="var(--ink)"
                strokeWidth="1.7"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={sparkline.last.x}
                cy={sparkline.last.y}
                r="3"
                fill="var(--ink)"
              />
            </svg>
          </div>
        </div>

        <div
          className={styles.compBar}
          data-comp-bar=""
          role="img"
          aria-label={compLabel}
        >
          {composition.map((seg) => (
            <span
              key={seg.tier}
              className={seg.housing ? `${styles.seg} ${styles.housing}` : styles.seg}
              style={
                seg.housing
                  ? { width: seg.width }
                  : { width: seg.width, background: seg.tone! }
              }
            />
          ))}
        </div>
        <div className={styles.compLegend}>
          {composition.map((seg) => (
            <span key={seg.tier}>
              <i
                className={seg.housing ? styles.housingSwatch : undefined}
                style={seg.housing ? undefined : { background: seg.tone! }}
              />
              {seg.label}
            </span>
          ))}
        </div>

        <div className={styles.sheetRows}>
          {rows.map((row) => (
            <div
              key={row.label}
              className={row.debit ? `${styles.r} ${styles.debit}` : styles.r}
            >
              <span>
                {row.label}
                {row.meta ? <span className={styles.num}> · {row.meta}</span> : null}
              </span>
              <span className={styles.num}>{row.value}</span>
            </div>
          ))}
        </div>
        <div className={styles.sheetFoot}>
          <span>Persona demo «Familia» · cierre {heroSheetData.closeMonthLabel}</span>
          <DemoLink />
        </div>
      </div>
    </figure>
  );
}

/** Sección 3: la correspondencia hoja→producto, respetuosa con el Excel. */
function Transition() {
  const ledger = [
    {
      what: "Posiciones con precio y retorno real",
      how: "IRR y TWR por posición, no una resta a ojo",
      device: <span className={`${styles.num} ${styles.up}`}>+11,2 %</span>,
    },
    {
      what: "Deudas con su cuadro y proyección",
      how: "amortización modelada, no celdas que envejecen",
      device: <span className={styles.num}>−148.210 €</span>,
    },
    {
      what: "Un motor que calcula — y explica — cada cifra",
      how: "pulsa una cifra y pregunta de dónde sale",
      device: null,
    },
    {
      what: "Histórico cerrado, mes a mes",
      how: "congelado y auditable: nada se recalcula a tus espaldas",
      device: <span className={styles.miniDbl} aria-hidden="true" />,
    },
    {
      what: "Precios y fuentes que se actualizan solos",
      how: "mercado y cripto, con cadencia honesta",
      device: null,
    },
  ];

  return (
    <section className={styles.entry} data-reveal-seat="">
      <div className={styles.entryHead}>
        <span className={styles.label}>La transición</span>
        <span className={styles.folio}>Asiento Nº 01</span>
      </div>
      <h2>De tu hoja… a worthline</h2>
      <p className={styles.intro}>
        Tu Excel era el enfoque correcto: <strong>una verdad tuya, fila a fila</strong>.
        Esto es el siguiente peldaño de la misma idea — sin fórmulas que mantener.
      </p>

      <div className={styles.diptych}>
        <div className={styles.reveal} data-reveal="">
          <div
            className={styles.xls}
            role="img"
            aria-label="Fragmento de tu hoja de cálculo, con una fórmula rota rodeada a pluma"
          >
            <table>
              <tbody>
                <tr>
                  <th style={{ width: "1.6rem" }} />
                  <th>A</th>
                  <th>B</th>
                  <th>C</th>
                </tr>
                <tr>
                  <td>4</td>
                  <td>MSCI World</td>
                  <td className={styles.num}>412</td>
                  <td className={styles.formula}>=B4*C4</td>
                </tr>
                <tr>
                  <td>5</td>
                  <td>Bitcoin</td>
                  <td className={styles.num}>0,412</td>
                  <td className={styles.num}>31.505</td>
                </tr>
                <tr>
                  <td>6</td>
                  <td>Piso Madrid</td>
                  <td className={styles.num}>?</td>
                  <td className={styles.err}>
                    <span className={styles.refError} data-ref-text="">
                      #¡REF!
                      <svg
                        className={styles.penCircle}
                        data-pen-circle=""
                        width="86"
                        height="40"
                        aria-hidden="true"
                      >
                        <ellipse pathLength="1" cx="43" cy="20" rx="38" ry="15" />
                      </svg>
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>7</td>
                  <td>Hipoteca</td>
                  <td className={styles.num}>-148.210</td>
                  <td className={styles.formula}>=HOY()-D2</td>
                </tr>
              </tbody>
            </table>
            <div className={styles.tabs}>
              <span>Cartera</span>
              <span>Deudas</span>
              <span className={styles.tabOn}>v2-final-FINAL</span>
            </div>
          </div>
          <span className={styles.penNote} data-pen-note="" aria-hidden="true">
            ¿te suena?
          </span>
        </div>
        <div className={styles.bridge} aria-hidden="true">
          →
        </div>
        <div className={styles.ledgerSide}>
          {ledger.map((row, index) => (
            <div
              key={row.what}
              className={`${styles.lr} ${styles.reveal}`}
              data-reveal=""
              style={{ "--reveal-delay": `${0.05 + index * 0.1}s` } as CSSProperties}
            >
              <span className={styles.what}>
                {row.what}
                <small>{row.how}</small>
              </span>
              {row.device}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Sección 4: las cuatro pruebas de profundidad inversora, con el mismo peso. */
function Proofs() {
  return (
    <section className={styles.entry} data-reveal-seat="">
      <div className={styles.entryHead}>
        <span className={styles.label}>Profundidad inversora</span>
        <span className={styles.folio}>Asiento Nº 02</span>
      </div>
      <h2>¿Está funcionando de verdad tu cartera?</h2>
      <p className={styles.intro}>
        Cuatro respuestas que una hoja de cálculo solo puede aproximar.
      </p>
      <div className={styles.quad}>
        <div className={`${styles.proof} ${styles.reveal}`} data-reveal="">
          <h3>Retornos reales</h3>
          <p>
            IRR y TWR por posición y cartera — la respuesta que tu Excel aproximaba con
            una resta.
          </p>
          <div className={styles.viz}>
            <div className={styles.fig}>
              <span className={styles.label}>MSCI World · 3A</span>
              <span className={styles.num}>TWR +11,2 % · IRR +9,8 %</span>
            </div>
            <svg
              className={styles.spark}
              data-draw=""
              viewBox="0 0 300 44"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polyline
                points="0,36 25,34 50,30 75,31 100,26 125,27 150,22 175,24 200,18 225,19 250,14 275,12 297,8"
                fill="none"
                stroke="var(--ink)"
                strokeWidth="1.6"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx="297" cy="8" r="3" fill="var(--ink)" />
            </svg>
            <p className={styles.vizLink}>
              <DemoLink />
            </p>
          </div>
        </div>
        <div
          className={`${styles.proof} ${styles.reveal}`}
          data-reveal=""
          style={{ "--reveal-delay": "0.1s" } as CSSProperties}
        >
          <h3>Cobros</h3>
          <p>
            Dividendos, intereses y rentas como registros de atribución — nunca inventados
            como cifra.
          </p>
          <div className={`${styles.viz} ${styles.payrows}`}>
            <div className={styles.r}>
              <span>Dividendos 2025</span>
              <span className={styles.num}>1.212 €</span>
            </div>
            <div className={styles.r}>
              <span>Intereses</span>
              <span className={styles.num}>635 €</span>
            </div>
            <div className={`${styles.r} ${styles.total}`}>
              <span>Total cobrado</span>
              <span className={styles.num}>1.847 €</span>
            </div>
            <p className={styles.vizLink}>
              <DemoLink />
            </p>
          </div>
        </div>
        <div
          className={`${styles.proof} ${styles.reveal}`}
          data-reveal=""
          style={{ "--reveal-delay": "0.15s" } as CSSProperties}
        >
          <h3>Exposición real</h3>
          <p>
            Look-through de fondos: qué geografías y divisas pesan de verdad en tu
            cartera.
          </p>
          <div className={styles.viz}>
            <div
              className={styles.expoBar}
              data-draw=""
              role="img"
              aria-label="EEUU 54 %, Europa 31 %, emergentes 8 %, otros 7 %"
            >
              <span
                className={styles.seg}
                style={{ width: "54%", background: "var(--tier-market)" }}
              />
              <span
                className={styles.seg}
                style={{ width: "31%", background: "var(--tier-term-locked)" }}
              />
              <span
                className={styles.seg}
                style={{ width: "8%", background: "var(--tier-illiquid)" }}
              />
              <span
                className={styles.seg}
                style={{ width: "7%", background: "var(--line-soft)" }}
              />
            </div>
            <div className={styles.expoLegend}>
              <span>EEUU 54 %</span>
              <span>Europa 31 %</span>
              <span>Emergentes 8 %</span>
              <span>Otros 7 %</span>
            </div>
            <p className={styles.vizLink}>
              <DemoLink />
            </p>
          </div>
        </div>
        <div
          className={`${styles.proof} ${styles.reveal}`}
          data-reveal=""
          style={{ "--reveal-delay": "0.2s" } as CSSProperties}
        >
          <h3>FIRE y objetivos</h3>
          <p>
            Proyección con tus números reales y objetivos con fecha — no una calculadora
            genérica.
          </p>
          <div className={styles.viz}>
            <div
              className={styles.track}
              data-draw=""
              role="img"
              aria-label="Progreso hacia la independencia: 31 por ciento"
            >
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((at) => (
                <span
                  key={at}
                  className={
                    at % 50 === 0 ? `${styles.tick} ${styles.tickMajor}` : styles.tick
                  }
                  style={{ left: `${at}%` }}
                />
              ))}
              <span className={styles.marker} style={{ left: "31%" }} />
            </div>
            <div className={styles.readout}>
              <span>
                hoy: <span className={styles.num}>31 %</span>
              </span>
              <span>
                independencia: <span className={styles.num}>2041</span>
              </span>
            </div>
            <p className={styles.vizLink}>
              <DemoLink />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Sección 5: la mecánica de actualizar, en lenguaje shipped-only. */
function Maintenance() {
  const steps = [
    {
      k: "03.1",
      title: "Importa tu extracto",
      body: "Tu extracto CSV/Excel → preview de lo que va a entrar → tú confirmas. Nada entra solo.",
    },
    {
      k: "03.2",
      title: "Fuentes conectadas",
      body: "Binance y Numista se sincronizan con un clic; cada posición sabe de dónde viene.",
    },
    {
      k: "03.3",
      title: "Precios solos",
      body: "Mercado y cripto se actualizan con cadencia honesta — y te dicen cuándo fue la última vez.",
    },
    {
      k: "03.4",
      title: "Alta guiada",
      body: "Lo que no viene de un fichero se añade paso a paso, sin fórmulas.",
    },
  ];

  return (
    <section className={styles.entry} data-reveal-seat="">
      <div className={styles.entryHead}>
        <span className={styles.label}>Mantenimiento</span>
        <span className={styles.folio}>Asiento Nº 03</span>
      </div>
      <h2>Actualizar deja de ser un trabajo</h2>
      <div className={styles.steps}>
        {steps.map((step, index) => (
          <div
            key={step.k}
            className={`${styles.s} ${styles.reveal}`}
            data-reveal=""
            style={{ "--reveal-delay": `${index * 0.08}s` } as CSSProperties}
          >
            <span className={`${styles.k} ${styles.num}`}>{step.k}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Sección 6: control y trazabilidad — la propiedad manda. */
function Control() {
  return (
    <section className={styles.entry} data-reveal-seat="">
      <div className={styles.entryHead}>
        <span className={styles.label}>Confianza</span>
        <span className={styles.folio}>Asiento Nº 04</span>
      </div>
      <h2>Tus cifras, cerradas y tuyas.</h2>
      <div className={styles.controlGrid}>
        <div className={`${styles.cg} ${styles.reveal}`} data-reveal="">
          <h3>
            Cada mes se cierra <span className={styles.miniDbl} aria-hidden="true" />
          </h3>
          <p>
            Y se congela. Nada se recalcula a tus espaldas; toda corrección queda
            auditada.
          </p>
        </div>
        <div
          className={`${styles.cg} ${styles.reveal}`}
          data-reveal=""
          style={{ "--reveal-delay": "0.1s" } as CSSProperties}
        >
          <h3>Tus datos salen contigo</h3>
          <p>Export completo en JSON, y tu espacio vive en su propia base de datos.</p>
        </div>
        <div
          className={`${styles.cg} ${styles.reveal}`}
          data-reveal=""
          style={{ "--reveal-delay": "0.2s" } as CSSProperties}
        >
          <h3>Sin conectar tu banco. A propósito.</h3>
          <p>
            Tus credenciales bancarias no viven aquí — tú decides qué entra, con preview.
          </p>
        </div>
      </div>
      <span className={styles.penName}>
        — la doble subraya significa «total», como en el papel
      </span>
    </section>
  );
}

/** Sección 7: la IA contenida — el asistente solo lee. */
function Assistant() {
  return (
    <section className={styles.entry} data-reveal-seat="">
      <div className={styles.entryHead}>
        <span className={styles.label}>Asistente</span>
        <span className={styles.folio}>Asiento Nº 05</span>
      </div>
      <h2>Habla con tu patrimonio. Y que te responda con la cifra exacta.</h2>
      <div className={styles.chatWrap}>
        <div className={`${styles.chatSheet} ${styles.reveal}`} data-reveal="">
          <p className={styles.who}>Tú</p>
          <p className={styles.q}>¿Cuánto cobré en dividendos en 2025?</p>
          <p className={styles.who}>worthline</p>
          <p className={`${styles.a} ${styles.srOnly}`} data-chat-semantic="">
            En 2025 cobraste <strong className={styles.num}>1.847 €</strong>:{" "}
            <span className={styles.num}>1.212 €</span> en dividendos y{" "}
            <span className={styles.num}>635 €</span> en intereses.<sup>1</sup>
          </p>
          <p className={styles.a} data-chat-visual="" aria-hidden="true">
            En 2025 cobraste <strong className={styles.num}>1.847 €</strong>:{" "}
            <span className={styles.num}>1.212 €</span> en dividendos y{" "}
            <span className={styles.num}>635 €</span> en intereses.<sup>1</sup>
          </p>
          <p className={styles.chatFoot} data-chat-foot="">
            <sup>1</sup> Fuente: tus registros de cobros ·{" "}
            <span className={styles.num}>14</span> apuntes
          </p>
          <p className={styles.mockNote}>
            Ejemplo de respuesta — las cifras dependen de tus datos.
          </p>
        </div>
        <div className={styles.chatAside}>
          <p>
            El asistente <strong>solo lee</strong>: responde con tus datos reales y cita
            de dónde sale cada cifra. <strong>Jamás escribe ni «estima» nada.</strong>
          </p>
          <p className={styles.chatAsideLink}>
            <DemoLink label="Pruébalo en la demo" />
          </p>
        </div>
      </div>
    </section>
  );
}

/** Secciones 8 y 9: la franja MCP y la contracubierta, un lienzo continuo. */
function Bookend() {
  return (
    <div className={styles.bookend}>
      <div className={styles.advanced}>
        <div className={styles.grain} aria-hidden="true" />
        <div className={styles.wrap}>
          <div>
            <p className={styles.eyebrow}>Para usuarios avanzados</p>
            <h2>Tu patrimonio, leíble por tu agente.</h2>
            <p>
              Conecta Claude — o cualquier cliente MCP — a tus datos con OAuth: contexto
              financiero, histórico, retornos, cobros, calidad de datos.
            </p>
            <p className={styles.motto}>
              Lectura completa. Escritura: ninguna, <em>de momento</em>.
            </p>
          </div>
          {/* Texto real, no role="img": las cifras del ejemplo son parte del
              mensaje y deben llegar también al lector de pantalla. */}
          <div className={styles.code}>
            <b>mcp</b> › get_financial_context
            <br />
            {`{ scope: "familia", asOf: "${heroSheetData.asOf}" }`}
            <br />→ neto: <b className={styles.num}>{heroSheetData.netLabel}</b> ·
            líquido: <b className={styles.num}>{heroSheetData.liquidLabel}</b>
            <br />→ fuente: cierre congelado {heroSheetData.closeMonthLabel}
            <br />
            <span className={styles.cm}>{"// write_*: todavía no"}</span>
          </div>
        </div>
      </div>

      <div className={styles.backcover}>
        <h2>
          Tu Excel ya hizo su trabajo<span className={styles.dot}>.</span>
        </h2>
        <p>
          Trae tu foto de hoy en unos minutos — sin fórmulas, con preview en cada paso. Y
          si un día quieres irte, tus datos salen contigo en un JSON.
        </p>
        <aside className={styles.beforeStart} aria-labelledby="before-start-title">
          <h3 id="before-start-title">Antes de empezar</h3>
          <ul>
            <li>
              worthline es un proyecto personal de código abierto, sin un SLA comercial.
              El precio y las condiciones comerciales todavía no están publicados.
            </li>
            <li>
              Cada workspace vive en su propia base de datos. Desde Ajustes puedes
              exportar todos tus datos en JSON o eliminar el workspace completo.
            </li>
            <li>
              worthline no guarda credenciales bancarias. Tú decides qué datos entran.
            </li>
            <li>{THIRD_PARTY_AI_NOTICE_TEXT}</li>
          </ul>
          <nav aria-label="Información para decidir">
            <a href="/demo">Probar con datos ficticios</a>
            <a href="https://github.com/jenarvaezg/worthline">Revisar el código</a>
            <a href="https://github.com/jenarvaezg/worthline/security/policy">
              Política de seguridad
            </a>
          </nav>
        </aside>
        <Ctas />
        <div className={styles.colophon}>
          <span className={styles.gl}>worthline · mmxxvi</span>
          <span>El libro mayor de tu patrimonio</span>
          <span>Hecho en español</span>
          <span>
            <a className={styles.demolink} href="/demo">
              Demo
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}

export default function LandingContent() {
  return (
    <div className={styles.landing} data-landing-root="" data-motion="pending">
      <Cover />
      <main className={styles.pages} id="paginas">
        <div className={styles.wrap}>
          <Transition />
          <Proofs />
          <Maintenance />
          <Control />
          <Assistant />
        </div>
        <Bookend />
      </main>
    </div>
  );
}
