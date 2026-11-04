"use client";

/**
 * PROTOTIPO #1880 — desechable. Las tres variantes del primer arranque de MyInvestor
 * (`?s5=A|B|C`), colgadas de la fila conectada que decidió #1879 (variante A). Nada
 * escribe: «Incluir» cambia el estado en memoria y enseña cómo queda la fila.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCOUNTS,
  type Account,
  eur,
  initialSelection,
  KIND_LABEL,
  PRODUCTS,
  type Product,
  RUNG_LABEL,
  type Rung,
  S5_VARIANTS,
  type S5VariantKey,
  summarize,
  withManualTwin,
} from "./discovery-model";
import styles from "./discovery-prototype.module.css";

type Toggle = (id: string) => void;

// ── Piezas compartidas ─────────────────────────────────────────────────────

function Notes({ product }: { product: Product }) {
  const notes: ReactNode[] = [];
  if (product.withheldMinor) {
    notes.push(
      `${eur(product.withheldMinor)} retenidos por órdenes en curso, ya dentro del saldo`,
    );
  }
  if (product.inheritedCostPending) {
    notes.push("Entró por traspaso desde otra entidad: te preguntaremos el coste (S7)");
  }
  if (product.manualTwin) {
    notes.push(
      `Ya lo tienes a mano en «${product.manualTwin}»: se revisa antes de enlazar (S6)`,
    );
  }
  if (product.members)
    notes.push(`Se enlaza entera: ${product.members.join(" · ")} (S8)`);
  if (notes.length === 0) return null;
  return (
    <span className={styles.notes}>
      {notes.map((note, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: prototipo
        <span key={index}>{note}</span>
      ))}
    </span>
  );
}

function history(product: Product): string {
  if (product.kind === "cash") return "Saldo de hoy, sin movimientos";
  return `${product.operations} operaciones desde ${product.since}`;
}

function ProductLine({
  checked,
  product,
  showAccount,
  toggle,
}: {
  checked: boolean;
  product: Product;
  showAccount?: boolean;
  toggle: Toggle;
}) {
  const account = ACCOUNTS.find((a) => a.id === product.accountId);
  return (
    <label className={styles.product} data-off={!checked || undefined}>
      <input checked={checked} onChange={() => toggle(product.id)} type="checkbox" />
      <span className={styles.productMain}>
        <span className={styles.productName}>{product.name}</span>
        <span className="conexSub">
          {KIND_LABEL[product.kind]} · <span className={styles.code}>{product.code}</span>
          {showAccount && account ? ` · ${account.label}` : ""}
          {product.otherHolder ? " · de otro titular" : ""}
        </span>
        <span className="conexSub">{history(product)}</span>
        <Notes product={product} />
      </span>
      <span className={styles.productNum}>
        {eur(product.valueMinor)}
        {product.units ? <span className="conexSub">{product.units} part.</span> : null}
      </span>
    </label>
  );
}

function GroupCheck({
  ids,
  label,
  selected,
  setMany,
  sub,
  total,
}: {
  ids: string[];
  label: string;
  selected: ReadonlySet<string>;
  setMany: (ids: string[], on: boolean) => void;
  sub: string;
  total?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const on = ids.filter((id) => selected.has(id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = on > 0 && on < ids.length;
  }, [on, ids.length]);
  return (
    <label className={styles.groupHead}>
      <input
        checked={on === ids.length}
        onChange={() => setMany(ids, on !== ids.length)}
        ref={ref}
        type="checkbox"
      />
      <span>
        <span className={styles.groupLabel}>{label}</span>
        <span className="conexSub">{sub}</span>
      </span>
      {total ? <span className={styles.productNum}>{total}</span> : null}
    </label>
  );
}

function SubmitLine({
  onSubmit,
  products,
  selected,
}: {
  onSubmit: () => void;
  products: Product[];
  selected: ReadonlySet<string>;
}) {
  const s = summarize(products, selected);
  const left = products.length - s.count;
  return (
    <div className={styles.submitLine}>
      <p>
        Se {s.count === 1 ? "crea" : "crean"} <strong>{s.count}</strong>{" "}
        {s.count === 1 ? "holding" : "holdings"} con <strong>{s.operations}</strong>{" "}
        operaciones, de una vez. Suman <strong>{eur(s.valueMinor)}</strong> al patrimonio.
        {left > 0 ? ` ${left} se quedan fuera; los puedes incluir más tarde.` : ""}
      </p>
      <button disabled={s.count === 0} onClick={onSubmit} type="button">
        Incluir {s.count} y traer su histórico
      </button>
    </div>
  );
}

interface VariantProps {
  products: Product[];
  selected: ReadonlySet<string>;
  toggle: Toggle;
  setMany: (ids: string[], on: boolean) => void;
  onSubmit: () => void;
}

// ── A · Por cuenta de MyInvestor ───────────────────────────────────────────

function AccountGroup({ account, ...props }: VariantProps & { account: Account }) {
  const items = props.products.filter((p) => p.accountId === account.id);
  return (
    <div className={styles.group}>
      <GroupCheck
        ids={items.map((p) => p.id)}
        label={account.label}
        selected={props.selected}
        setMany={props.setMany}
        sub={account.sub}
      />
      {items.map((p) => (
        <ProductLine
          checked={props.selected.has(p.id)}
          key={p.id}
          product={p}
          toggle={props.toggle}
        />
      ))}
    </div>
  );
}

function VariantA(props: VariantProps) {
  const own = ACCOUNTS.filter((a) => !a.otherHolder);
  const others = ACCOUNTS.filter((a) => a.otherHolder);
  return (
    <div className={styles.fold}>
      <p className="muted">
        Esto es lo que hay en tu MyInvestor. Lo marcado se crea en worthline con todo su
        histórico y de solo lectura: lo pone al día MyInvestor.
      </p>
      {own.map((account) => (
        <AccountGroup account={account} key={account.id} {...props} />
      ))}
      <h4 className={styles.othersHead}>De otro titular · llega sin marcar</h4>
      {others.map((account) => (
        <AccountGroup account={account} key={account.id} {...props} />
      ))}
      <SubmitLine {...props} />
    </div>
  );
}

// ── B · Por peldaño de worthline ───────────────────────────────────────────

const RUNG_ORDER: Rung[] = ["liquid", "invested", "retirement"];

function VariantB(props: VariantProps) {
  return (
    <div className={styles.fold}>
      <p className="muted">
        Así entraría en tu patrimonio. Lo marcado se crea con todo su histórico y de solo
        lectura.
      </p>
      {RUNG_ORDER.map((rung) => {
        const items = props.products.filter((p) => p.rung === rung);
        const sum = summarize(items, props.selected);
        return (
          <div className={styles.group} key={rung}>
            <GroupCheck
              ids={items.map((p) => p.id)}
              label={RUNG_LABEL[rung]}
              selected={props.selected}
              setMany={props.setMany}
              sub={`${sum.count} de ${items.length} marcados`}
              total={eur(sum.valueMinor)}
            />
            {items.map((p) => (
              <ProductLine
                checked={props.selected.has(p.id)}
                key={p.id}
                product={p}
                showAccount
                toggle={props.toggle}
              />
            ))}
          </div>
        );
      })}
      <SubmitLine {...props} />
    </div>
  );
}

// ── C · Página propia con la consecuencia al lado ──────────────────────────

function VariantC(props: VariantProps) {
  const s = summarize(props.products, props.selected);
  const own = ACCOUNTS.filter((a) => !a.otherHolder);
  const others = ACCOUNTS.filter((a) => a.otherHolder);
  return (
    <section aria-label="Elegir qué incluir" className={styles.page}>
      <p className={styles.fakeUrl}>/ajustes/conexiones/myinvestor/incluir</p>
      <h2 className={styles.pageTitle}>Qué traer de MyInvestor</h2>
      <div className={styles.pageGrid}>
        <div>
          {own.map((account) => (
            <AccountGroup account={account} key={account.id} {...props} />
          ))}
          <h4 className={styles.othersHead}>De otro titular · llega sin marcar</h4>
          {others.map((account) => (
            <AccountGroup account={account} key={account.id} {...props} />
          ))}
        </div>
        <aside className={styles.basket}>
          <h3 className={styles.basketHead}>Así queda tu patrimonio</h3>
          <dl className={styles.ledger}>
            {RUNG_ORDER.map((rung) => (
              <div key={rung}>
                <dt>{RUNG_LABEL[rung]}</dt>
                <dd className={s.byRung[rung] > 0 ? "pos" : undefined}>
                  {s.byRung[rung] > 0 ? `+${eur(s.byRung[rung])}` : eur(0)}
                </dd>
              </div>
            ))}
            <div className={styles.ledgerTotal}>
              <dt>Al patrimonio</dt>
              <dd>+{eur(s.valueMinor)}</dd>
            </div>
          </dl>
          <p className="muted">
            {s.count} holdings y {s.operations} operaciones, en un solo lote. De solo
            lectura: los pone al día MyInvestor.
          </p>
          {s.pendingCost > 0 ? (
            <p className={styles.basketNote}>
              {s.pendingCost} {s.pendingCost === 1 ? "entrada" : "entradas"} por traspaso
              sin coste: te lo preguntaremos después.
            </p>
          ) : null}
          {s.twins > 0 ? (
            <p className={styles.basketNote}>
              {s.twins} ya {s.twins === 1 ? "lo tienes" : "los tienes"} a mano: antes de
              enlazar verás qué cambia.
            </p>
          ) : null}
          <button disabled={s.count === 0} onClick={props.onSubmit} type="button">
            Incluir {s.count} y traer su histórico
          </button>
        </aside>
      </div>
    </section>
  );
}

// ── Lo que queda tras incluir ──────────────────────────────────────────────

function AfterCreate({
  products,
  selected,
  toggle,
}: {
  products: Product[];
  selected: ReadonlySet<string>;
  toggle: Toggle;
}) {
  const left = products.filter((p) => !selected.has(p.id));
  return (
    <details className="conexCredentials" open>
      <summary>Productos de MyInvestor</summary>
      <p className="muted">
        {products.length - left.length} incluidos. Lo que dejaste fuera no toca el
        patrimonio:
      </p>
      <ul className={styles.leftList}>
        {left.map((p) => (
          <li key={p.id}>
            <span>
              {p.name}
              <span className="conexSub">
                {KIND_LABEL[p.kind]} · {eur(p.valueMinor)}
                {p.otherHolder ? " · de otro titular" : ""}
              </span>
            </span>
            <button
              className={styles.textControl}
              onClick={() => toggle(p.id)}
              type="button"
            >
              Incluir con su histórico
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ── El conmutador ──────────────────────────────────────────────────────────

function Switcher({
  current,
  onChange,
}: {
  current: S5VariantKey;
  onChange: (next: S5VariantKey) => void;
}) {
  const index = Math.max(
    0,
    S5_VARIANTS.findIndex((v) => v.key === current),
  );
  const cycle = useCallback(
    (step: number) => {
      const next = S5_VARIANTS[(index + step + S5_VARIANTS.length) % S5_VARIANTS.length];
      if (next) onChange(next.key);
    },
    [index, onChange],
  );
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);
  return (
    <div aria-label="Variantes del prototipo" className={styles.switcher} role="group">
      <button aria-label="Variante anterior" onClick={() => cycle(-1)} type="button">
        ←
      </button>
      <span>
        <span className={styles.switcherPrefix}>Prototipo #1880 · </span>
        {S5_VARIANTS[index]?.key} ({S5_VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

export default function DiscoveryPrototype({
  initialVariant,
}: {
  initialVariant: S5VariantKey;
}) {
  const [variant, setVariant] = useState<S5VariantKey>(initialVariant);
  const [twin, setTwin] = useState(false);
  const products = useMemo(() => withManualTwin(PRODUCTS, twin), [twin]);
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(PRODUCTS));
  const [created, setCreated] = useState(false);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const changeVariant = useCallback((next: S5VariantKey) => {
    setVariant(next);
    setCreated(false);
    setSelected(initialSelection(PRODUCTS));
    const url = new URL(window.location.href);
    url.searchParams.set("s5", next);
    window.history.replaceState(null, "", url);
  }, []);

  const s = summarize(products, selected);
  const props: VariantProps = {
    onSubmit: () => setCreated(true),
    products,
    selected,
    setMany,
    toggle,
  };
  const pageMode = variant === "C" && !created;

  return (
    <section aria-label="Prototipo #1880" className={styles.prototype}>
      {pageMode ? null : (
        <div className="tableScroll">
          <table className="conexTable">
            <thead>
              <tr>
                <th>Fuente</th>
                <th>Estado</th>
                <th>Última sincronización</th>
                <th className="conexNum">Elementos</th>
                <th className="conexNum">Valor</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="conexName">MyInvestor</span>
                  <span className="conexSub">Cuentas, fondos y planes</span>
                </td>
                <td>
                  <span className={`coinStatusPill ${created ? "" : "isPending"}`.trim()}>
                    {created ? "Al día" : "Falta elegir qué incluir"}
                  </span>
                  <span className="conexSub">Se pone al día cuando pulses</span>
                </td>
                <td>{created ? "Hoy, 12:04" : "Nunca"}</td>
                <td className="conexNum">
                  {created ? s.count : 0}
                  <span className="conexSub">productos</span>
                </td>
                <td className="conexNum">{created ? eur(s.valueMinor) : "—"}</td>
                <td>
                  <span className="conexActions">
                    {created ? (
                      <button className="btnSecondary" type="button">
                        Poner al día (S9)
                      </button>
                    ) : null}
                  </span>
                </td>
              </tr>
              <tr className="conexDetailRow">
                <td colSpan={6}>
                  {created ? (
                    <>
                      <p className="successBand" role="status">
                        {s.count} holdings creados con {s.operations} operaciones, en un
                        solo lote.
                      </p>
                      <AfterCreate
                        products={products}
                        selected={selected}
                        toggle={toggle}
                      />
                    </>
                  ) : variant === "A" ? (
                    <details className="conexCredentials" open>
                      <summary>Elegir qué incluir</summary>
                      <VariantA {...props} />
                    </details>
                  ) : variant === "B" ? (
                    <details className="conexCredentials" open>
                      <summary>Elegir qué incluir</summary>
                      <VariantB {...props} />
                    </details>
                  ) : null}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {pageMode ? <VariantC {...props} /> : null}

      <div className={styles.controls}>
        <strong>Prototipo #1880 · primer arranque</strong>
        <label>
          <input
            checked={twin}
            onChange={(e) => setTwin(e.target.checked)}
            type="checkbox"
          />{" "}
          Con un holding manual del mismo ISIN (gancho de S6)
        </label>
        <button
          onClick={() => {
            setCreated(false);
            setSelected(initialSelection(PRODUCTS));
          }}
          type="button"
        >
          Reiniciar
        </button>
      </div>

      <Switcher current={variant} onChange={changeVariant} />
    </section>
  );
}
