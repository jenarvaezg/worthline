/**
 * PROTOTIPO #162 — CSS desechable, todo bajo el prefijo `np-` (numista
 * prototype). Vive en un <style> en línea para que borrar el prototipo sea
 * `rm -rf prototipo-numista/` sin tocar globals.css. Reutiliza los tokens reales
 * (--panel, --ink, --muted, --line-soft, --radius, --shadow…) del sistema de
 * diseño; los tonos de metal son los únicos colores nuevos y son decorativos.
 */

const CSS = `
/* ── Marco del prototipo ─────────────────────────────────────────────────── */
.np-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 0.9rem;
  margin: 0 0 1.4rem;
  padding: 0.7rem 0.95rem;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-sm);
  background: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 9px,
    rgba(179, 131, 31, 0.06) 9px,
    rgba(179, 131, 31, 0.06) 18px
  );
}
.np-banner strong { font-weight: 700; }
.np-banner span { color: var(--muted); font-size: 0.82rem; }

.np-surface { margin: 0 0 1.6rem; }
.np-surfaceLabel {
  display: block;
  margin: 0 0 0.55rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

/* ── Tags de base de valoración (metal/colección/compra/cero) ────────────── */
.np-tag {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-size: 0.64rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid var(--line-soft);
  color: var(--muted);
  vertical-align: middle;
}
.np-tagMetal { border-color: #c8b27d; color: #8a6a18; }
.np-tagColeccion { border-color: #9fb6c8; color: var(--blue); }
.np-tagCompra { border-color: var(--line); color: var(--muted); }
.np-tagCero { border-color: #d8b6a8; color: var(--red); }

.np-alt { color: var(--muted); text-decoration: line-through; font-size: 0.82rem; }
.np-num { font-variant-numeric: tabular-nums; }
.np-readonly { color: var(--muted); }
.np-readonly small { display: block; font-size: 0.66rem; }

/* ── Swatch de metal (variante C línea de Patrimonio) ────────────────────── */
.np-swatches { display: inline-flex; gap: 3px; margin-left: 0.45rem; vertical-align: middle; }
.np-swatch { width: 9px; height: 9px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.18); }

/* ── Micro-barra apilada por metal (variante B línea de Patrimonio) ──────── */
.np-stack { display: inline-flex; height: 8px; width: 120px; max-width: 100%; border-radius: 999px; overflow: hidden; margin-top: 0.3rem; }
.np-stack i { height: 100%; min-width: 2px; }

/* ── Variante A — secciones de metal estilo «tier» ───────────────────────── */
.np-metal { border-top: 1px solid var(--hairline); }
.np-metal:first-of-type { border-top: 0; }
.np-metal > summary {
  display: grid;
  grid-template-columns: 1fr auto 3.2rem 9rem;
  align-items: center;
  gap: 0.75rem;
  padding: 0.62rem 0.2rem;
  cursor: pointer;
  list-style: none;
}
.np-metal > summary::-webkit-details-marker { display: none; }
.np-metalName { font-weight: 650; display: flex; align-items: center; gap: 0.5rem; }
.np-metalName::before {
  content: ""; width: 11px; height: 11px; border-radius: 3px;
  background: var(--np-tone, var(--muted));
}
.np-metalName small { color: var(--muted); font-weight: 400; }
.np-metal b { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
.np-metalShare { color: var(--muted); font-size: 0.8rem; text-align: right; font-variant-numeric: tabular-nums; }
.np-metalBar { height: 6px; border-radius: 999px; background: var(--hairline); overflow: hidden; }
.np-metalBar > i { display: block; height: 100%; background: var(--np-tone, var(--muted)); }
.np-metalCoins { padding: 0 0 0.5rem; }

/* ── Variante B — composición por metal (tira + ecualizador) ──────────────── */
/* Tira 100 % apilada: el reparto del catálogo, de un vistazo. */
.np-compStrip {
  display: flex; height: 26px; border-radius: 999px; overflow: hidden;
  margin: 0.2rem 0 1rem; border: 1px solid var(--line-soft);
}
.np-compStrip > i { display: block; height: 100%; min-width: 2px; }
/* Filas de proporción: barras altas que forman un ecualizador descendente. La
   BARRA es el contenido (34px), no una decoración de 6px como en A/C. */
.np-propRow { border-top: 1px solid var(--hairline); }
.np-propRow:first-of-type { border-top: 0; }
.np-propRow > summary {
  display: grid; grid-template-columns: 9rem 1fr 7.5rem; align-items: center;
  gap: 0.9rem; padding: 0.6rem 0.2rem; cursor: pointer; list-style: none;
}
.np-propRow > summary::-webkit-details-marker { display: none; }
.np-propLabel { display: flex; align-items: center; gap: 0.5rem; font-weight: 650; }
.np-propLabel::before {
  content: ""; width: 11px; height: 11px; border-radius: 3px;
  background: var(--np-tone, var(--muted));
}
.np-propLabel small { color: var(--muted); font-weight: 400; }
.np-propBar {
  display: flex; align-items: center; height: 34px; border-radius: var(--radius-sm);
  background: var(--hairline); overflow: hidden;
}
.np-propBar > i { height: 100%; background: var(--np-tone, var(--muted)); }
.np-propPct {
  flex: 0 0 auto; padding: 0 0.5rem; font-weight: 700; color: var(--ink);
  font-variant-numeric: tabular-nums; font-size: 0.82rem; white-space: nowrap;
}
.np-propVal { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.np-propVal small { display: block; font-weight: 400; color: var(--muted); font-size: 0.7rem; }
/* Detalle desplegado: lista mínima SIN cabecera (jamás la tabla de A). */
.np-coinList { padding: 0.1rem 0.2rem 0.7rem; }
.np-coinLine {
  display: grid; grid-template-columns: 1fr auto 9rem; gap: 0.9rem;
  align-items: baseline; padding: 0.35rem 0.2rem; border-top: 1px dashed var(--hairline);
}
.np-coinLine:first-child { border-top: 0; }
.np-coinLine small { color: var(--muted); }
.np-coinLine .np-coinAmt { text-align: right; }
@media (max-width: 720px) {
  .np-propRow > summary { grid-template-columns: 7rem 1fr 6rem; gap: 0.5rem; }
}

/* ── Variante C — galería de monedas ─────────────────────────────────────── */
.np-band {
  display: flex; align-items: baseline; gap: 0.6rem; margin: 1.1rem 0 0.6rem;
  padding-bottom: 0.35rem; border-bottom: 2px solid var(--np-tone, var(--line));
}
.np-band h4 { margin: 0; font-size: 0.95rem; font-weight: 650; }
.np-band .np-bandCount { color: var(--muted); font-size: 0.78rem; }
.np-band .np-bandTotal { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; }
.np-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 0.7rem; }
.np-coin {
  position: relative; background: var(--panel); border: 1px solid var(--line-soft);
  border-radius: var(--radius); box-shadow: var(--shadow); padding: 0.85rem 0.9rem;
  border-top: 3px solid var(--np-tone, var(--line));
}
.np-coinName { font-weight: 650; line-height: 1.25; }
.np-coinMeta { color: var(--muted); font-size: 0.78rem; margin: 0.15rem 0 0.6rem; }
.np-coinValue { font-size: 1.3rem; font-weight: 760; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.np-coinAlt { margin-top: 0.1rem; }
.np-coinFoot { display: flex; align-items: center; justify-content: space-between; margin-top: 0.55rem; }
.np-gradeChip {
  display: inline-block; padding: 0.08rem 0.45rem; border-radius: 999px;
  border: 1px solid var(--line); font-size: 0.68rem; font-weight: 650; color: var(--ink);
}
.np-coinQty { color: var(--muted); font-size: 0.74rem; }

/* ── Conectar / sincronizar ──────────────────────────────────────────────── */
.np-card {
  background: var(--panel); border: 1px solid var(--line-soft);
  border-radius: var(--radius); box-shadow: var(--shadow); padding: 1.1rem 1.2rem;
}
.np-field { display: block; margin-bottom: 0.7rem; }
.np-field span { display: block; font-size: 0.78rem; color: var(--muted); margin-bottom: 0.25rem; }
.np-field input {
  width: 100%; padding: 0.5rem 0.6rem; border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm); background: var(--paper); font: inherit; color: var(--ink);
}
.np-btnPrimary {
  background: var(--ink); color: var(--paper); border: 0; border-radius: var(--radius-sm);
  padding: 0.55rem 1rem; font: inherit; font-weight: 650; cursor: pointer;
}
.np-btnOutline {
  background: transparent; color: var(--ink); border: 1px solid var(--line-strong);
  border-radius: 999px; padding: 0.45rem 0.95rem; font: inherit; font-weight: 650; cursor: pointer;
}
.np-syncLine {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem 1rem;
  color: var(--muted); font-size: 0.85rem;
}
.np-statusPill {
  display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.65rem;
  border-radius: 999px; border: 1px solid var(--line-soft); font-size: 0.78rem; font-weight: 650; color: var(--ink);
}
.np-statusPill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
.np-statusGrid { display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: center; }
.np-statusStats { display: flex; gap: 1.6rem; margin-top: 0.6rem; }
.np-statusStats div span { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.np-statusStats div b { font-variant-numeric: tabular-nums; }

.np-steps { display: grid; gap: 0.8rem; }
.np-step { display: grid; grid-template-columns: auto 1fr; gap: 0.9rem; align-items: start; }
.np-stepNum {
  width: 1.9rem; height: 1.9rem; border-radius: 50%; background: var(--ink); color: var(--paper);
  display: grid; place-items: center; font-weight: 700;
}
.np-stepBody { flex: 1; }
.np-stepBody h4 { margin: 0.25rem 0 0.5rem; font-size: 0.92rem; font-weight: 650; }
.np-fieldRow { display: flex; flex-wrap: wrap; gap: 0.6rem; }
.np-fieldRow .np-field { flex: 1 1 160px; margin-bottom: 0; }
.np-dim { color: var(--muted); font-size: 0.82rem; }

/* ── Barra flotante de variantes (solo prototipo) ────────────────────────── */
.np-switcher {
  position: fixed; bottom: 1.1rem; left: 50%; transform: translateX(-50%); z-index: 50;
  display: flex; align-items: center; gap: 0.2rem;
  background: var(--ink); color: var(--ink-panel-text);
  border-radius: 999px; padding: 0.3rem 0.4rem; box-shadow: 0 8px 24px rgba(0,0,0,0.28);
}
.np-switcher a {
  color: var(--ink-panel-text); text-decoration: none; width: 2rem; height: 2rem;
  display: grid; place-items: center; border-radius: 999px; font-size: 1.1rem;
}
.np-switcher a:hover { background: rgba(255,255,255,0.12); }
.np-switcherLabel { padding: 0 0.7rem; font-size: 0.82rem; font-weight: 650; white-space: nowrap; }
.np-switcherLabel small { display: block; color: var(--ink-panel-muted); font-weight: 400; font-size: 0.68rem; }
`;

export default function PrototypeStyles() {
  return <style>{CSS}</style>;
}
