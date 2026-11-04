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
 * A product a manual holding already is (#1881, design C) has no box: three radios
 * decide it — «Enlazar con «X»», «Crear aparte», «No incluir» — with the reason it
 * is a twin above them. With «Enlazar» chosen, the verdict in one sentence appears
 * under it, and «Ver las N operaciones» unfolds the exact pairing. The panel adds a
 * linked holding by its difference only, never its whole value.
 *
 * A robo-advisor's account (#1883) is ONE row, «Cartera gestionada», with a line of
 * its funds and its cash under it; one box includes the whole block. When a
 * portfolio kept by hand may be it, the same three radios decide it as a unit, and
 * «Enlazar» unfolds one verdict per fund (#1881's) plus a line for the cash. A
 * manual member MyInvestor lacks disables «Enlazar», with the reason, the remedy and
 * a link to the portfolio's ficha.
 *
 * The boxes and radios are a native form (`productKey`, `twin:<key>`), so it
 * submits without JavaScript; the island only keeps the choice and recomputes the
 * panel with the same pure summary the server uses (interaction-patterns §7). The
 * fold lives OUTSIDE the table's `.tableScroll`, or the panel could not stay put
 * while the list scrolls.
 */

import { includeMyInvestorProductsAction } from "@web/ajustes/myinvestor-actions";
import type { MyInvestorCareo } from "@web/ajustes/myinvestor-careo";
import {
  careoOfChoice,
  defaultMyInvestorTwinChoices,
  isIncludable,
  isTwinDecision,
  MYINVESTOR_KIND_LABEL,
  MYINVESTOR_RUNG_LABEL,
  type MyInvestorAccountGroup,
  type MyInvestorProductRow,
  type MyInvestorRung,
  type MyInvestorTwinChoice,
  myInvestorGroupState,
  myInvestorTwinField,
  portfolioOfChoice,
  setMyInvestorSelection,
  setMyInvestorTwinChoice,
  summarizeMyInvestorSelection,
  toggleMyInvestorSelection,
  twinCandidateOfChoice,
} from "@web/ajustes/myinvestor-selection";
import { formatMoneyMinorPrivacy, formatUnits } from "@worthline/domain";
import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  myInvestorCareoRowCells,
  myInvestorCareoVerdict,
  myInvestorHistoryLine,
  myInvestorPortfolioCashLine,
  myInvestorPortfolioComposition,
  myInvestorPortfolioMemberHead,
  myInvestorPortfolioMembersLine,
  myInvestorPortfolioTwinLegend,
  myInvestorPortfolioTwinOptions,
  myInvestorPortfolioWitnessLine,
  myInvestorRowNotes,
  myInvestorTwinCashLine,
  myInvestorTwinLegend,
  myInvestorTwinOptions,
} from "./myinvestor-first-start-view";

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
      <ProductText money={money} row={row} />
      <ProductNum money={money} row={row} />
    </label>
  );
}

/** The name, kind, identifier, history and notes of a product: one copy for both lines. */
function ProductText({
  money,
  row,
}: {
  money: (minor: number) => string;
  row: MyInvestorProductRow;
}) {
  const history = myInvestorHistoryLine(row);
  const notes = myInvestorRowNotes(row, money);
  const composition = myInvestorPortfolioComposition(row);
  const members = myInvestorPortfolioMembersLine(row);
  const witness = myInvestorPortfolioWitnessLine(row, money);
  return (
    <span className="myinvestorProductMain">
      <span className="myinvestorProductName">{row.name}</span>
      <span className="conexSub">
        {MYINVESTOR_KIND_LABEL[row.kind]}
        {composition ? ` · ${composition}` : ""}
        {row.identifier ? (
          <>
            {" · "}
            <span className="myinvestorCodeId">{row.identifier}</span>
          </>
        ) : null}
        {row.otherHolder ? " · de otro titular" : ""}
      </span>
      {members ? <span className="conexSub">{members}</span> : null}
      {history ? <span className="conexSub">{history}</span> : null}
      {witness ? <span className="conexSub">{witness}</span> : null}
      {notes.length > 0 ? (
        <span className="myinvestorNotes">
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function ProductNum({
  money,
  row,
}: {
  money: (minor: number) => string;
  row: MyInvestorProductRow;
}) {
  return (
    <span className="myinvestorProductNum">
      {money(row.valueMinor)}
      {row.units !== null && row.kind !== "cash" ? (
        <span className="conexSub">{formatUnits(row.units)} part.</span>
      ) : null}
    </span>
  );
}

/** The verdict and, folded, every operation with what linking does to it. */
function Careo({
  careo,
  money,
}: {
  careo: MyInvestorCareo;
  money: (minor: number) => string;
}) {
  const operations = careo.rows.length === 1 ? "operación" : "operaciones";
  return (
    <div className="myinvestorCareo">
      <p className="myinvestorVerdict">{myInvestorCareoVerdict(careo, money)}</p>
      {careo.rows.length > 0 ? (
        <details className="conexCredentials" suppressHydrationWarning>
          <summary>
            Ver las {careo.rows.length} {operations}
          </summary>
          <div className="myinvestorCareoScroll">
            <table className="conexRunTable myinvestorCareoOps">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Operación</th>
                  <th className="num" scope="col">
                    Importe
                  </th>
                  <th className="num" scope="col">
                    Part.
                  </th>
                  <th scope="col">Al enlazar</th>
                </tr>
              </thead>
              <tbody>
                {careo.rows.map((row, index) => {
                  const cells = myInvestorCareoRowCells(row, money);
                  return (
                    <tr
                      data-mark={row.mark}
                      // A ledger can hold two identical rows: the index tells them apart.
                      key={`${row.mark}-${row.date}-${row.amountMinor}-${index}`}
                    >
                      <td>{cells.date}</td>
                      <td>{cells.kind}</td>
                      <td className="num">{cells.amount}</td>
                      <td className="num">{cells.units}</td>
                      <td>
                        <span
                          className={`myinvestorCareoMark ${
                            row.mark === "leaves"
                              ? "neg"
                              : row.mark === "enters"
                                ? "pos"
                                : ""
                          }`.trim()}
                        >
                          {cells.mark}
                        </span>
                        {cells.hint ? (
                          <span className="conexSub">{cells.hint}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * A robo-advisor's block a portfolio kept by hand may be (#1883): the same three
 * ways out, as a unit. With «Enlazar» chosen, a verdict per fund and the cash line.
 */
function PortfolioTwinProduct({
  choice,
  money,
  onChoose,
  row,
}: {
  choice: MyInvestorTwinChoice;
  money: (minor: number) => string;
  onChoose: (key: string, choice: MyInvestorTwinChoice) => void;
  row: MyInvestorProductRow;
}) {
  const twin = row.portfolioTwin;
  if (!twin) return null;
  const portfolio = portfolioOfChoice(row, choice);
  const cashLine = portfolio ? myInvestorPortfolioCashLine(portfolio, money) : null;
  return (
    <div className="myinvestorTwin" data-off={choice === "skip" || undefined}>
      <div className="myinvestorTwinHead">
        <ProductText money={money} row={row} />
        <ProductNum money={money} row={row} />
      </div>
      <fieldset className="myinvestorTwinChoice">
        <legend className="conexSub">{myInvestorPortfolioTwinLegend(twin)}</legend>
        {myInvestorPortfolioTwinOptions(twin).map((option) => (
          <label data-disabled={option.disabled || undefined} key={option.value}>
            <input
              checked={choice === option.value}
              disabled={option.disabled}
              name={myInvestorTwinField(row.key)}
              onChange={() => onChoose(row.key, option.value)}
              type="radio"
              value={option.value}
            />
            <span>
              {option.label}
              {option.note ? (
                <span className="myinvestorNotes">
                  <span>
                    {option.note}
                    {option.href ? (
                      <>
                        {" "}
                        <Link href={option.href}>Abrir la cartera</Link>
                      </>
                    ) : null}
                  </span>
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      {/* Choosing «Enlazar» mounts the verdicts below: said once, as they appear. */}
      <p aria-live="polite" className="srOnly">
        {portfolio
          ? portfolio.members
              .map((member) =>
                member.careo
                  ? `${myInvestorPortfolioMemberHead(member, money)} ${myInvestorCareoVerdict(member.careo, money)}`
                  : myInvestorPortfolioMemberHead(member, money),
              )
              .join(" ")
          : ""}
      </p>
      {portfolio ? (
        <ul className="myinvestorPortfolioCareo">
          {portfolio.members.map((member) => (
            <li key={member.productKey}>
              <p className="myinvestorVerdict">
                {myInvestorPortfolioMemberHead(member, money)}
              </p>
              {member.careo ? <Careo careo={member.careo} money={money} /> : null}
            </li>
          ))}
          {cashLine ? (
            <li>
              <p className="myinvestorVerdict">{cashLine}</p>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** A product a manual holding already is, or may be: three ways out (#1881). */
function TwinProduct({
  choice,
  money,
  onChoose,
  row,
}: {
  choice: MyInvestorTwinChoice;
  money: (minor: number) => string;
  onChoose: (key: string, choice: MyInvestorTwinChoice) => void;
  row: MyInvestorProductRow;
}) {
  if (row.portfolioTwin) {
    return (
      <PortfolioTwinProduct choice={choice} money={money} onChoose={onChoose} row={row} />
    );
  }
  const twin = row.twin;
  if (!twin) return null;
  const careo = careoOfChoice(row, choice);
  // A cash account has no careo: linking it says what its balance becomes.
  const chosen = twinCandidateOfChoice(row, choice);
  const cashLine = chosen ? myInvestorTwinCashLine(chosen, money) : null;
  return (
    <div className="myinvestorTwin" data-off={choice === "skip" || undefined}>
      <div className="myinvestorTwinHead">
        <ProductText money={money} row={row} />
        <ProductNum money={money} row={row} />
      </div>
      <fieldset className="myinvestorTwinChoice">
        <legend className="conexSub">{myInvestorTwinLegend(twin)}</legend>
        {myInvestorTwinOptions(twin).map((option) => (
          <label key={option.value}>
            <input
              checked={choice === option.value}
              name={myInvestorTwinField(row.key)}
              onChange={() => onChoose(row.key, option.value)}
              type="radio"
              value={option.value}
            />
            <span>
              {option.label}
              {option.note ? (
                <span className="myinvestorNotes">
                  <span>{option.note}</span>
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      {/* Choosing «Enlazar» mounts the verdict below: said once, as it appears. */}
      <p aria-live="polite" className="srOnly">
        {careo ? myInvestorCareoVerdict(careo, money) : (cashLine ?? "")}
      </p>
      {careo ? <Careo careo={careo} money={money} /> : null}
      {cashLine ? <p className="myinvestorVerdict">{cashLine}</p> : null}
    </div>
  );
}

function AccountGroup({
  choices,
  choose,
  group,
  money,
  selected,
  setMany,
  toggle,
}: {
  choices: ReadonlyMap<string, MyInvestorTwinChoice>;
  choose: (key: string, choice: MyInvestorTwinChoice) => void;
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
      {group.products.map((row) =>
        isTwinDecision(row) ? (
          <TwinProduct
            choice={choices.get(row.key) ?? "skip"}
            key={row.key}
            money={money}
            onChoose={choose}
            row={row}
          />
        ) : (
          <ProductLine
            checked={selected.has(row.key)}
            key={row.key}
            money={money}
            onToggle={toggle}
            row={row}
          />
        ),
      )}
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
  const [choices, setChoices] = useState<ReadonlyMap<string, MyInvestorTwinChoice>>(() =>
    defaultMyInvestorTwinChoices(rows),
  );
  const choose = useCallback((key: string, choice: MyInvestorTwinChoice) => {
    setChoices((previous) => setMyInvestorTwinChoice(previous, key, choice));
  }, []);
  const summary = summarizeMyInvestorSelection(rows, selected, choices);
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
  const operationsNoun = summary.operations === 1 ? "operación" : "operaciones";
  const signed = (minor: number) => (minor > 0 ? `+${money(minor)}` : money(minor));
  const signClass = (minor: number) =>
    minor > 0 ? "pos" : minor < 0 ? "neg" : undefined;
  const nothing = summary.count === 0 && summary.linked === 0;
  const cta =
    summary.linked === 0
      ? `Incluir ${summary.count} y traer su histórico`
      : summary.count === 0
        ? `Enlazar ${summary.linked}`
        : `Incluir ${summary.count} y enlazar ${summary.linked}`;

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
        histórico y de solo lectura: lo pone al día MyInvestor. Lo que ya llevas a mano se
        puede enlazar: MyInvestor sustituye sus operaciones.
      </p>
      <div className="myinvestorIncludeGrid">
        <div>
          {own.map((group) => (
            <AccountGroup
              choices={choices}
              choose={choose}
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
                  choices={choices}
                  choose={choose}
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
            {`${summary.count} ${summary.count === 1 ? "nuevo" : "nuevos"} y ${summary.linked} ${summary.linked === 1 ? "enlazado" : "enlazados"}, ${signed(summary.valueMinor)} al patrimonio.`}
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
            {summary.linked > 0 ? (
              <div>
                <dt>Enlazados ({summary.linked})</dt>
                <dd className={signClass(summary.linkedDeltaMinor)}>
                  {signed(summary.linkedDeltaMinor)}
                </dd>
              </div>
            ) : null}
            <div className="myinvestorLedgerTotal totalRule">
              <dt>Al patrimonio</dt>
              <dd>{signed(summary.valueMinor)}</dd>
            </div>
          </dl>
          <p className="muted">
            {summary.count} {summary.count === 1 ? "nuevo" : "nuevos"}
            {summary.linked > 0
              ? ` y ${summary.linked} ${summary.linked === 1 ? "enlazado" : "enlazados"}`
              : ""}
            , con {summary.operations} {operationsNoun}, en un solo lote. Los fondos y
            planes entran a su coste hasta que worthline traiga su precio.
          </p>
          {summary.linked > 0 ? (
            <p className="muted">
              Un enlace solo suma la diferencia con lo que ya tenías a mano, no el valor
              entero.
            </p>
          ) : null}
          {summary.pendingCost > 0 ? (
            <p className="myinvestorBasketNote">
              {summary.pendingCost} {summary.pendingCost === 1 ? "entrada" : "entradas"}{" "}
              por traspaso desde otra entidad: te preguntaremos lo que costó.
            </p>
          ) : null}
          {summary.plansClosing > 0 ? (
            <p className="myinvestorBasketNote">
              {summary.plansClosing === 1
                ? "1 plan de aportación se cierra hoy"
                : `${summary.plansClosing} planes de aportación se cierran hoy`}
              : lo enlazado lo trae MyInvestor.
            </p>
          ) : null}
          {error ? (
            <p className="errorBand" role="alert">
              {error}
            </p>
          ) : null}
          <button
            aria-busy={pending || undefined}
            disabled={pending || nothing}
            type="submit"
          >
            {pending ? "Trayendo el histórico…" : cta}
          </button>
        </aside>
      </div>
    </form>
  );
}

/**
 * After the first include, a product a manual holding already is and was left out
 * (#1881): the same three choices and careo, on their own, so it can still be linked
 * or created apart later — «Incluir con su histórico» for a twin.
 */
export function MyInvestorTwinLater({
  currentUrl,
  privacyMode,
  row,
  sourceId,
}: {
  currentUrl: string;
  privacyMode: boolean;
  row: MyInvestorProductRow;
  sourceId: string;
}) {
  const money = useMoney(privacyMode);
  const [choice, setChoice] = useState<MyInvestorTwinChoice>("skip");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
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
  return (
    <form
      // The SAME server action, for the no-JS post: without `inlineError` it
      // redirects on every terminal, so what it resolves to is never read.
      action={
        includeMyInvestorProductsAction as unknown as (
          formData: FormData,
        ) => Promise<void>
      }
      className="myinvestorTwinLater"
      onSubmit={onSubmit}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="sourceId" type="hidden" value={sourceId} />
      <TwinProduct
        choice={choice}
        money={money}
        onChoose={(_key, next) => setChoice(next)}
        row={row}
      />
      {error ? (
        <p className="errorBand" role="alert">
          {error}
        </p>
      ) : null}
      <button
        aria-busy={pending || undefined}
        className="btnSecondary"
        disabled={pending || choice === "skip"}
        type="submit"
      >
        {pending
          ? "Trayendo el histórico…"
          : choice === "separate"
            ? "Crear aparte con su histórico"
            : "Enlazar"}
      </button>
    </form>
  );
}
