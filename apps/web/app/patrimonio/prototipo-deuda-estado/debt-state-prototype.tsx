"use client";

import { useMemo, useState } from "react";

import {
  annualRateFromMonthlyPayment,
  BASELINE_DATE,
  monthlyPaymentFromAnnualRate,
  remainingMonthlyPayments,
} from "./amortization";
import styles from "./prototipo-deuda-estado.module.css";

type InputMode = "rate" | "payment";

const BASELINE_LABEL = "2 jul 2026";
const moneyFormatter = new Intl.NumberFormat("es-ES", {
  currency: "EUR",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});
const percentFormatter = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

function parseAmount(value: string): number {
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  return Number(normalized);
}

function formatMoney(value: number): string {
  return moneyFormatter.format(value);
}

function formatPercent(value: number): string {
  return `${percentFormatter.format(value)} %`;
}

export default function DebtStatePrototype() {
  const [balance, setBalance] = useState("118000");
  const [endDate, setEndDate] = useState("2032-06-30");
  const [inputMode, setInputMode] = useState<InputMode>("rate");
  const [annualRate, setAnnualRate] = useState("2,35");
  const [monthlyPayment, setMonthlyPayment] = useState("1758,75");
  const [confirmed, setConfirmed] = useState(false);

  const projection = useMemo(() => {
    const parsedBalance = parseAmount(balance);
    const months = remainingMonthlyPayments(BASELINE_DATE, endDate);

    if (!Number.isFinite(parsedBalance) || parsedBalance <= 0) {
      return { error: "Introduce un saldo pendiente mayor que 0 €.", months };
    }

    if (months <= 0) {
      return { error: "La fecha de fin tiene que ser posterior a hoy.", months };
    }

    if (inputMode === "rate") {
      const parsedRate = parseAmount(annualRate);
      const derivedPayment = monthlyPaymentFromAnnualRate(
        parsedBalance,
        parsedRate,
        months,
      );

      if (!Number.isFinite(parsedRate) || parsedRate < 0 || derivedPayment === null) {
        return { error: "Introduce un tipo anual igual o mayor que 0 %.", months };
      }

      return {
        declared: formatPercent(parsedRate),
        derivedLabel: "Cuota mensual estimada",
        derivedValue: formatMoney(derivedPayment),
        honesty: `Con estos datos tu cuota sale ${formatMoney(derivedPayment)} al mes. ¿Cuadra con tu banco?`,
        months,
        totalInterest: formatMoney(derivedPayment * months - parsedBalance),
      };
    }

    const parsedPayment = parseAmount(monthlyPayment);
    const solvedRate = annualRateFromMonthlyPayment(parsedBalance, parsedPayment, months);

    if (
      !Number.isFinite(parsedPayment) ||
      parsedPayment <= 0 ||
      solvedRate.kind === "invalid"
    ) {
      return { error: "Introduce una cuota mensual mayor que 0 €.", months };
    }

    if (solvedRate.kind === "payment-too-low") {
      return {
        error: `Esa cuota no liquida la deuda antes de la fecha de fin. Mínimo: ${formatMoney(
          solvedRate.minimumPayment,
        )} al mes.`,
        months,
      };
    }

    return {
      declared: formatMoney(parsedPayment),
      derivedLabel: "Tipo anual equivalente",
      derivedValue: formatPercent(solvedRate.annualRatePercent),
      honesty: `Con estos datos el tipo sale ${formatPercent(
        solvedRate.annualRatePercent,
      )} anual. ¿Cuadra con tu banco?`,
      months,
      totalInterest: formatMoney(parsedPayment * months - parsedBalance),
    };
  }, [annualRate, balance, endDate, inputMode, monthlyPayment]);

  const hasError = "error" in projection;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p>Patrimonio · Deuda</p>
        <h1>Alta por estado actual</h1>
        <span>Hoy: {BASELINE_LABEL}</span>
      </header>

      <div className={styles.layout}>
        <section className={styles.panel} aria-labelledby="debt-form-title">
          <div className={styles.panelHeader}>
            <div>
              <h2 id="debt-form-title">Datos que sí tienes</h2>
              <p>El saldo de hoy fija la verdad; el plan solo corre hacia delante.</p>
            </div>
            <span className={styles.badge}>Amortización francesa</span>
          </div>

          <form className={styles.form}>
            <label>
              <span>Saldo pendiente hoy</span>
              <input
                inputMode="decimal"
                onChange={(event) => {
                  setBalance(event.target.value);
                  setConfirmed(false);
                }}
                value={balance}
              />
            </label>

            <label>
              <span>Fecha de fin</span>
              <input
                min={BASELINE_DATE}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setConfirmed(false);
                }}
                type="date"
                value={endDate}
              />
            </label>

            <fieldset className={styles.toggle}>
              <legend>Dato del banco</legend>
              <label>
                <input
                  checked={inputMode === "rate"}
                  name="inputMode"
                  onChange={() => {
                    setInputMode("rate");
                    setConfirmed(false);
                  }}
                  type="radio"
                />
                <span>Tengo el tipo anual</span>
              </label>
              <label>
                <input
                  checked={inputMode === "payment"}
                  name="inputMode"
                  onChange={() => {
                    setInputMode("payment");
                    setConfirmed(false);
                  }}
                  type="radio"
                />
                <span>Tengo la cuota mensual</span>
              </label>
            </fieldset>

            {inputMode === "rate" ? (
              <label>
                <span>Tipo anual actual</span>
                <input
                  inputMode="decimal"
                  onChange={(event) => {
                    setAnnualRate(event.target.value);
                    setConfirmed(false);
                  }}
                  value={annualRate}
                />
              </label>
            ) : (
              <label>
                <span>Cuota mensual actual</span>
                <input
                  inputMode="decimal"
                  onChange={(event) => {
                    setMonthlyPayment(event.target.value);
                    setConfirmed(false);
                  }}
                  value={monthlyPayment}
                />
              </label>
            )}
          </form>

          <div
            className={hasError ? styles.errorCheck : styles.honestyCheck}
            aria-live="polite"
          >
            {hasError ? (
              <p>{projection.error}</p>
            ) : (
              <>
                <span>{projection.derivedLabel}</span>
                <strong>{projection.derivedValue}</strong>
                <p>{projection.honesty}</p>
              </>
            )}
          </div>

          <button
            className={styles.confirmButton}
            disabled={hasError}
            onClick={() => setConfirmed(true)}
            type="button"
          >
            Confirmar alta por estado actual
          </button>
        </section>

        <aside className={styles.panel} aria-labelledby="summary-title">
          <div className={styles.panelHeader}>
            <div>
              <h2 id="summary-title">Resumen antes de guardar</h2>
              <p>Esto es lo que entraría en la ficha de deuda.</p>
            </div>
          </div>

          <dl className={styles.summary}>
            <div>
              <dt>Saldo base</dt>
              <dd>
                {Number.isFinite(parseAmount(balance))
                  ? formatMoney(parseAmount(balance))
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Cuotas restantes</dt>
              <dd>{projection.months}</dd>
            </div>
            <div>
              <dt>{inputMode === "rate" ? "Tipo declarado" : "Cuota declarada"}</dt>
              <dd>{"declared" in projection ? projection.declared : "—"}</dd>
            </div>
            <div>
              <dt>
                {"derivedLabel" in projection ? projection.derivedLabel : "Comprobación"}
              </dt>
              <dd>
                {"derivedValue" in projection ? projection.derivedValue : "Pendiente"}
              </dd>
            </div>
            <div>
              <dt>Intereses futuros</dt>
              <dd>{"totalInterest" in projection ? projection.totalInterest : "—"}</dd>
            </div>
          </dl>

          <div className={styles.timeline} aria-label="Alcance histórico">
            <div>
              <span>Antes de hoy</span>
              <strong>Sin saldos inventados</strong>
              <p>No se reconstruyen las revisiones ni amortizaciones antiguas.</p>
            </div>
            <div>
              <span>Desde hoy</span>
              <strong>Plan amortizado</strong>
              <p>
                La deuda proyecta cuotas, fin y futuras recalibraciones desde el saldo
                base.
              </p>
            </div>
          </div>

          <p className={styles.confirmation} aria-live="polite">
            {confirmed
              ? "Listo para guardar: la historia de esta deuda empieza en el saldo de hoy."
              : "La fecha de firma puede guardarse como dato descriptivo; no crea historia pasada."}
          </p>
        </aside>
      </div>
    </main>
  );
}
