"use client";

/**
 * «Elegir qué incluir» of MyInvestor's first start (#1880, design D: the fold by
 * account of A with «Así queda tu patrimonio» of C beside it).
 *
 * - Left, by MyInvestor account as the bank shows them: a group box (with its
 *   mixed state) and the products under it — name, kind, strong identifier, units,
 *   value and the history it brings, with a gold-ruled note for what another slice
 *   still has to do. What belongs to someone else goes last, unticked.
 * - Right, sticky from 960 px and under the list on a phone: what each rung adds,
 *   the total, «N holdings y M operaciones, en un solo lote», the warnings and the
 *   ONE primary button.
 *
 * The boxes are a native form (`productKey`), so it submits without JavaScript; the
 * island only keeps the choice and recomputes the panel with the same pure summary
 * the server uses (interaction-patterns §7). The fold lives OUTSIDE the table's
 * `.tableScroll`, or the panel could not stay put while the list scrolls.
 */

import { includeMyInvestorProductsAction } from "@web/ajustes/myinvestor-actions";
import {
  isIncludable,
  MYINVESTOR_KIND_LABEL,
  MYINVESTOR_RUNG_LABEL,
  type MyInvestorAccountGroup,
  type MyInvestorProductRow,
  type MyInvestorRung,
  myInvestorGroupState,
  setMyInvestorSelection,
  summarizeMyInvestorSelection,
  toggleMyInvestorSelection,
} from "@web/ajustes/myinvestor-selection";
import { formatMoneyMinorPrivacy, formatUnits } from "@worthline/domain";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { myInvestorHistoryLine, myInvestorRowNotes } from "./myinvestor-first-start-view";

const RUNG_ORDER: readonly MyInvestorRung[] = ["liquid", "invested", "retirement"];

function useMoney(privacyMode: boolean) {
  return useCallback(
    (minor: number) =>
      formatMoneyMinorPrivacy({ amountMinor: minor, currency: "EUR" }, privacyMode),
    [privacyMode],
  );
}

function ProductLine({
  checked,
  money,
  onToggle,
  row,
}: {
  checked: boolean;
  money: (minor: number) => string;
  onToggle: (key: string) => void;
  row: MyInvestorProductRow;
}) {
  const includable = isIncludable(row);
  const history = myInvestorHistoryLine(row);
  const notes = myInvestorRowNotes(row, money);
  return (
    <label className="myinvestorProduct" data-off={!checked || undefined}>
      <input
        checked={includable && checked}
        disabled={!includable}
        name="productKey"
        onChange={() => onToggle(row.key)}
        type="checkbox"
        value={row.key}
      />
      <span className="myinvestorProductMain">
        <span className="myinvestorProductName">{row.name}</span>
        <span className="conexSub">
          {MYINVESTOR_KIND_LABEL[row.kind]}
          {row.identifier ? (
            <>
              {" · "}
              <span className="myinvestorCodeId">{row.identifier}</span>
            </>
          ) : null}
          {row.otherHolder ? " · de otro titular" : ""}
        </span>
        {history ? <span className="conexSub">{history}</span> : null}
        {notes.length > 0 ? (
          <span className="myinvestorNotes">
            {notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="myinvestorProductNum">
        {money(row.valueMinor)}
        {row.units !== null && row.kind !== "cash" ? (
          <span className="conexSub">{formatUnits(row.units)} part.</span>
        ) : null}
      </span>
    </label>
  );
}

function AccountGroup({
  group,
  money,
  selected,
  setMany,
  toggle,
}: {
  group: MyInvestorAccountGroup;
  money: (minor: number) => string;
  selected: ReadonlySet<string>;
  setMany: (keys: readonly string[], on: boolean) => void;
  toggle: (key: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const includable = group.products.filter(isIncludable).map((row) => row.key);
  const state = myInvestorGroupState(includable, selected);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "mixed";
  }, [state]);
  return (
    <div className="myinvestorGroup">
      <label className="myinvestorGroupHead">
        <input
          aria-label={`Incluir todo ${group.account.label}`}
          checked={state === "all"}
          disabled={includable.length === 0}
          onChange={() => setMany(includable, state !== "all")}
          ref={ref}
          type="checkbox"
        />
        <span>
          <span className="myinvestorGroupLabel">{group.account.label}</span>
          <span className="conexSub">{group.account.sub}</span>
        </span>
      </label>
      {group.products.map((row) => (
        <ProductLine
          checked={selected.has(row.key)}
          key={row.key}
          money={money}
          onToggle={toggle}
          row={row}
        />
      ))}
    </div>
  );
}

export default function MyInvestorIncludeFold({
  currentUrl,
  others,
  own,
  privacyMode,
  sourceId,
}: {
  currentUrl: string;
  own: readonly MyInvestorAccountGroup[];
  others: readonly MyInvestorAccountGroup[];
  privacyMode: boolean;
  sourceId: string;
}) {
  const money = useMoney(privacyMode);
  const rows = useMemo(
    () => [...own, ...others].flatMap((group) => group.products),
    [own, others],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(rows.filter((row) => row.selectedByDefault).map((row) => row.key)),
  );
  const toggle = useCallback((key: string) => {
    setSelected((previous) => toggleMyInvestorSelection(previous, key));
  }, []);
  const setMany = useCallback((keys: readonly string[], on: boolean) => {
    setSelected((previous) => setMyInvestorSelection(previous, keys, on));
  }, []);
  const summary = summarizeMyInvestorSelection(rows, selected);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A refusal comes back as state, beside the button, with the boxes as they were;
  // only success redirects (interaction-patterns §4.1).
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("inlineError", "1");
    setError(null);
    startTransition(async () => {
      const result = await includeMyInvestorProductsAction(formData);
      setError(result.ok ? null : result.error);
    });
  };
  const holdingsNoun = summary.count === 1 ? "holding" : "holdings";
  const operationsNoun = summary.operations === 1 ? "operación" : "operaciones";

  return (
    <form
      // The SAME server action, for the no-JS post: without `inlineError` it
      // redirects on every terminal, so what it resolves to is never read.
      action={
        includeMyInvestorProductsAction as unknown as (
          formData: FormData,
        ) => Promise<void>
      }
      className="myinvestorInclude"
      onSubmit={onSubmit}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      <p className="muted">
        Esto es lo que hay en tu MyInvestor. Lo marcado se crea en worthline con todo su
        histórico y de solo lectura: lo pone al día MyInvestor.
      </p>
      <div className="myinvestorIncludeGrid">
        <div>
          {own.map((group) => (
            <AccountGroup
              group={group}
              key={group.account.key}
              money={money}
              selected={selected}
              setMany={setMany}
              toggle={toggle}
            />
          ))}
          {others.length > 0 ? (
            <>
              <h4 className="myinvestorOthersHead">De otro titular · llega sin marcar</h4>
              {others.map((group) => (
                <AccountGroup
                  group={group}
                  key={group.account.key}
                  money={money}
                  selected={selected}
                  setMany={setMany}
                  toggle={toggle}
                />
              ))}
            </>
          ) : null}
        </div>
        <aside aria-label="Así queda tu patrimonio" className="myinvestorBasket">
          <h3 className="myinvestorBasketHead">Así queda tu patrimonio</h3>
          {/* What ticking a box changed, said once: the panel recomputes silently. */}
          <p aria-live="polite" className="srOnly">
            {`${summary.count} ${holdingsNoun} marcados, ${money(summary.valueMinor)} al patrimonio.`}
          </p>
          <dl className="myinvestorLedger">
            {RUNG_ORDER.map((rung) => (
              <div key={rung}>
                <dt>{MYINVESTOR_RUNG_LABEL[rung]}</dt>
                <dd className={summary.byRung[rung] > 0 ? "pos" : undefined}>
                  {summary.byRung[rung] > 0
                    ? `+${money(summary.byRung[rung])}`
                    : money(0)}
                </dd>
              </div>
            ))}
            <div className="myinvestorLedgerTotal totalRule">
              <dt>Al patrimonio</dt>
              <dd>+{money(summary.valueMinor)}</dd>
            </div>
          </dl>
          <p className="muted">
            {summary.count} {holdingsNoun} y {summary.operations} {operationsNoun}, en un
            solo lote. Los fondos y planes entran a su coste hasta que worthline traiga su
            precio.
          </p>
          {summary.pendingCost > 0 ? (
            <p className="myinvestorBasketNote">
              {summary.pendingCost} {summary.pendingCost === 1 ? "entrada" : "entradas"}{" "}
              por traspaso desde otra entidad: te preguntaremos lo que costó.
            </p>
          ) : null}
          {summary.twins > 0 ? (
            <p className="myinvestorBasketNote">
              {summary.twins} ya {summary.twins === 1 ? "lo tienes" : "los tienes"} a
              mano: se revisarán antes de enlazarlos.
            </p>
          ) : null}
          {error ? (
            <p className="errorBand" role="alert">
              {error}
            </p>
          ) : null}
          <button
            aria-busy={pending || undefined}
            disabled={pending || summary.count === 0}
            type="submit"
          >
            {pending
              ? "Trayendo el histórico…"
              : `Incluir ${summary.count} y traer su histórico`}
          </button>
        </aside>
      </div>
    </form>
  );
}
