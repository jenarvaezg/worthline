"use client";

/**
 * PROTOTIPO — throwaway. Asistente de alta de holdings (revamp UX, grill 2026-06-25).
 * Pregunta que responde: ¿qué FORMA de asistente se siente mejor para alguien no
 * técnico? El contenido (5 cajones, lenguaje llano, bifurcación de inversión,
 * inmueble sin muro, reparto de un toque) ya está decidido; aquí varía la forma:
 *   A — asistente a pantalla completa (una pregunta por pantalla)
 *   B — una sola página que se revela
 *   C — dos paneles (rail + lienzo con tarjeta-previa)
 * Brief completo: scratchpad/holding-wizard-ux-brief.md
 * Datos mock, en memoria, sin mutaciones reales. Borrar cuando gane una variante.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const VARIANTS = ["A", "B", "C"] as const;
type Variant = (typeof VARIANTS)[number];
const VARIANT_NAME: Record<Variant, string> = {
  A: "Asistente a pantalla completa",
  B: "Una sola página que se revela",
  C: "Dos paneles (rail + lienzo)",
};

// ---------------------------------------------------------------------------
// Datos mock (sustituyen al store real en el prototipo)
// ---------------------------------------------------------------------------
const MEMBERS = ["Tu padre", "Su mujer"] as const;

type CajonId = "dinero" | "inversion" | "inmueble" | "bien" | "deuda";
interface Cajon {
  id: CajonId;
  icon: string;
  label: string;
  blurb: string;
  tier: string; // token de color de capa
}
const CAJONES: Cajon[] = [
  {
    id: "dinero",
    icon: "💶",
    label: "Dinero",
    blurb: "Cuentas, efectivo. Lo que puedes gastar ya.",
    tier: "var(--tier-cash)",
  },
  {
    id: "inversion",
    icon: "📈",
    label: "Una inversión",
    blurb: "Fondos, acciones, plan de pensiones, cripto.",
    tier: "var(--tier-market)",
  },
  {
    id: "inmueble",
    icon: "🏠",
    label: "Un inmueble",
    blurb: "Tu casa, un piso, un local.",
    tier: "var(--tier-housing)",
  },
  {
    id: "bien",
    icon: "🚗",
    label: "Otro bien",
    blurb: "Coche, oro, objetos de valor.",
    tier: "var(--tier-illiquid)",
  },
  {
    id: "deuda",
    icon: "🧾",
    label: "Una deuda",
    blurb: "Hipoteca, préstamo, tarjeta.",
    tier: "var(--red)",
  },
];
const cajonOf = (id: CajonId | null) => CAJONES.find((c) => c.id === id);

const INV_GROUPS = [
  { id: "bolsa", label: "Cotiza en bolsa", hint: "Fondo, ETF, acción, índice" },
  { id: "pension", label: "Plan de pensiones", hint: "" },
  { id: "cripto", label: "Cripto", hint: "Bitcoin, Ethereum…" },
] as const;
const DEUDA_TIPOS = [
  { id: "hipoteca", label: "Hipoteca" },
  { id: "prestamo", label: "Préstamo" },
  { id: "tarjeta", label: "Tarjeta de crédito" },
] as const;
const BIEN_TIPOS = [
  { id: "coche", label: "Coche" },
  { id: "oro", label: "Oro / metal" },
  { id: "otro", label: "Otro" },
] as const;

// Catálogo mock para la búsqueda con precio en vivo (real: SymbolSearch → Yahoo/Finect/CoinGecko)
const MARKET_CATALOG: {
  group: string;
  name: string;
  symbol: string;
  provider: string;
  price: number;
}[] = [
  {
    group: "bolsa",
    name: "iShares Core MSCI World",
    symbol: "EUNL.DE",
    provider: "Yahoo Finance",
    price: 92.15,
  },
  {
    group: "bolsa",
    name: "Vanguard Global Stock",
    symbol: "VWCE.DE",
    provider: "Yahoo Finance",
    price: 118.4,
  },
  {
    group: "bolsa",
    name: "Apple",
    symbol: "AAPL",
    provider: "Yahoo Finance",
    price: 180.5,
  },
  {
    group: "bolsa",
    name: "S&P 500",
    symbol: "^GSPC",
    provider: "Yahoo Finance",
    price: 5200,
  },
  {
    group: "pension",
    name: "Indexa Más Rentabilidad Acciones",
    symbol: "N5394",
    provider: "Finect",
    price: 12.8,
  },
  {
    group: "cripto",
    name: "Bitcoin",
    symbol: "bitcoin",
    provider: "CoinGecko",
    price: 58000,
  },
  {
    group: "cripto",
    name: "Ethereum",
    symbol: "ethereum",
    provider: "CoinGecko",
    price: 2400,
  },
];
const providerFor = (group: string | null) =>
  group === "cripto" ? "CoinGecko" : group === "pension" ? "Finect" : "Yahoo Finance";

// ---------------------------------------------------------------------------
// Estado del formulario, compartido entre variantes (misma data, 3 formas)
// ---------------------------------------------------------------------------
interface AddedItem {
  cajon: CajonId;
  name: string;
  amount: number;
  owner: string;
}
interface Form {
  cajon: CajonId | null;
  name: string;
  amount: string;
  atPlazo: boolean;
  invGroup: string | null;
  invSymbol: string;
  invPriceLive: number | null;
  invMode: "saldo" | "import" | null;
  vivienda: boolean;
  bienTipo: string | null;
  deudaTipo: string | null;
  owner: "mio" | "medios" | "otro";
}
const EMPTY_FORM: Form = {
  cajon: null,
  name: "",
  amount: "",
  atPlazo: false,
  invGroup: null,
  invSymbol: "",
  invPriceLive: null,
  invMode: null,
  vivienda: true,
  bienTipo: null,
  deudaTipo: null,
  owner: "medios", // default "de los dos" (su norma)
};

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n);
const toNum = (s: string) => Number(s.replace(/[.\s]/g, "").replace(",", ".")) || 0;
const ownerLabel = (o: Form["owner"]) =>
  o === "mio"
    ? "Solo tuyo"
    : o === "medios"
      ? "De los dos (mitad y mitad)"
      : "Reparto personalizado";

// ---------------------------------------------------------------------------
// Piezas de UI compartidas (estética de worthline vía tokens de globals.css)
// ---------------------------------------------------------------------------
const card: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line-soft)",
  borderRadius: "var(--radius)",
  boxShadow: "var(--shadow)",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6, fontSize: "0.95rem", color: "var(--ink)" }}>
      <span style={{ fontWeight: 600 }}>
        {label}{" "}
        {hint ? (
          <small style={{ color: "var(--muted)", fontWeight: 400 }}>{hint}</small>
        ) : null}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  font: "inherit",
  padding: "12px 14px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-strong)",
  background: "var(--paper)",
  color: "var(--ink)",
};

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...inputStyle, ...(props.style ?? {}) }} />;
}

function ChipRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: string; hint?: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              font: "inherit",
              cursor: "pointer",
              padding: "8px 14px",
              borderRadius: 999,
              border: active ? "1px solid var(--ink)" : "1px solid var(--line-strong)",
              background: active ? "var(--ink)" : "transparent",
              color: active ? "var(--panel)" : "var(--ink)",
              fontWeight: 600,
            }}
          >
            {o.label}
            {o.hint ? (
              <small style={{ opacity: 0.7, fontWeight: 400 }}> · {o.hint}</small>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (b: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        cursor: "pointer",
        color: "var(--ink)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18 }}
      />
      <span>{children}</span>
    </label>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        font: "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        padding: "13px 22px",
        borderRadius: "var(--radius-sm)",
        border: "none",
        background: "var(--ink)",
        color: "var(--panel)",
        fontWeight: 650,
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        font: "inherit",
        cursor: "pointer",
        padding: "13px 22px",
        borderRadius: 999,
        border: "1px solid var(--line-strong)",
        background: "transparent",
        color: "var(--blue)",
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

function OwnershipControl({
  value,
  onChange,
}: {
  value: Form["owner"];
  onChange: (v: Form["owner"]) => void;
}) {
  const opts: { id: Form["owner"]; label: string }[] = [
    { id: "mio", label: "Solo mío" },
    { id: "medios", label: "De los dos (mitad y mitad)" },
    { id: "otro", label: "Otro reparto…" },
  ];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <ChipRow options={opts} value={value} onChange={onChange} />
      {value === "otro" ? (
        <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
          {MEMBERS.map((m, i) => (
            <Field key={m} label={m}>
              <TextInput
                defaultValue={i === 0 ? "70" : "30"}
                style={{ width: 80 }}
                inputMode="decimal"
              />{" "}
              %
            </Field>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Campos mínimos del cajón elegido (compartidos por A/B/C, mismo contenido)
// Búsqueda de activo con precio en vivo, dentro del grupo elegido (mantiene la
// SymbolSearch actual: buscar BTC en CoinGecko, un fondo en Yahoo, etc.)
function MockSymbolSearch({
  form,
  set,
}: {
  form: Form;
  set: (patch: Partial<Form>) => void;
}) {
  const [q, setQ] = useState("");
  const [manual, setManual] = useState(false);
  const provider = providerFor(form.invGroup);
  const resolved = !!form.invSymbol && form.invPriceLive != null;
  const fromCatalog = MARKET_CATALOG.some((c) => c.symbol === form.invSymbol);
  const results =
    q.trim().length >= 2
      ? MARKET_CATALOG.filter(
          (c) =>
            c.group === form.invGroup &&
            c.name.toLowerCase().includes(q.toLowerCase().trim()),
        )
      : [];

  if (resolved) {
    return (
      <div style={{ ...card, padding: 14, display: "grid", gap: 4 }}>
        <small style={{ color: "var(--muted)" }}>
          {fromCatalog ? "Encontrado · precio en vivo" : "Precio manual"} · {provider}
        </small>
        <strong style={{ color: "var(--ink)" }}>
          {form.name}{" "}
          <span style={{ color: "var(--muted)", fontWeight: 400 }}>
            · {form.invSymbol}
          </span>
        </strong>
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>
          {eur(form.invPriceLive!)} / ud
        </span>
        <button
          type="button"
          onClick={() => set({ invSymbol: "", invPriceLive: null })}
          style={{
            justifySelf: "start",
            background: "none",
            border: "none",
            color: "var(--blue)",
            cursor: "pointer",
            font: "inherit",
            padding: 0,
          }}
        >
          Cambiar
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Field
        label={`Busca tu ${form.invGroup === "cripto" ? "cripto" : form.invGroup === "pension" ? "plan" : "fondo, acción o ETF"}`}
        hint={`precio en vivo · ${provider}`}
      >
        <TextInput
          value={q}
          placeholder={
            form.invGroup === "cripto"
              ? "Bitcoin, Ethereum…"
              : "Vanguard, Apple, MSCI World…"
          }
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
      </Field>
      {results.length > 0 ? (
        <div style={{ display: "grid", gap: 6 }}>
          {results.map((r) => (
            <button
              key={r.symbol}
              type="button"
              onClick={() => {
                set({ name: r.name, invSymbol: r.symbol, invPriceLive: r.price });
                setQ("");
              }}
              style={{
                ...card,
                font: "inherit",
                cursor: "pointer",
                textAlign: "left",
                padding: "10px 12px",
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <span>
                <strong style={{ color: "var(--ink)" }}>{r.name}</strong>{" "}
                <small style={{ color: "var(--muted)" }}>· {r.symbol}</small>
              </span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
                {eur(r.price)}
              </span>
            </button>
          ))}
        </div>
      ) : q.trim().length >= 2 ? (
        <small style={{ color: "var(--muted)" }}>
          Nada con «{q}».{" "}
          <button
            type="button"
            onClick={() => setManual(true)}
            style={{
              background: "none",
              border: "none",
              color: "var(--blue)",
              cursor: "pointer",
              font: "inherit",
              padding: 0,
            }}
          >
            Meterlo a mano →
          </button>
        </small>
      ) : (
        <button
          type="button"
          onClick={() => setManual(true)}
          style={{
            justifySelf: "start",
            background: "none",
            border: "none",
            color: "var(--blue)",
            cursor: "pointer",
            font: "inherit",
            padding: 0,
          }}
        >
          No lo encuentro, meterlo a mano →
        </button>
      )}
      {manual ? (
        <div style={{ display: "grid", gap: 10, marginTop: 4 }}>
          <Field label="Código (si lo sabes)" hint="(opcional)">
            <TextInput
              value={form.invSymbol}
              placeholder="EUNL.DE / bitcoin"
              onChange={(e) => set({ invSymbol: e.target.value })}
            />
          </Field>
          <Field label="Precio por unidad" hint="(no hay precio en vivo)">
            <TextInput
              placeholder="92,15 €"
              inputMode="decimal"
              onChange={(e) => set({ invPriceLive: toNum(e.target.value) || null })}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function CajonFields({ form, set }: { form: Form; set: (patch: Partial<Form>) => void }) {
  if (form.cajon === "dinero") {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Field label="¿Cómo lo llamas?">
          <TextInput
            value={form.name}
            placeholder="Cuenta del banco"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="¿Cuánto hay?">
          <TextInput
            value={form.amount}
            placeholder="2.500 €"
            inputMode="decimal"
            onChange={(e) => set({ amount: e.target.value })}
          />
        </Field>
        <Toggle checked={form.atPlazo} onChange={(b) => set({ atPlazo: b })}>
          Está a plazo fijo (no lo puedo sacar aún)
        </Toggle>
      </div>
    );
  }
  if (form.cajon === "inmueble") {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Field label="¿Cómo lo llamas?">
          <TextInput
            value={form.name}
            placeholder="Mi casa"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="¿Cuánto vale hoy, más o menos?">
          <TextInput
            value={form.amount}
            placeholder="300.000 €"
            inputMode="decimal"
            onChange={(e) => set({ amount: e.target.value })}
          />
        </Field>
        <Toggle checked={form.vivienda} onChange={(b) => set({ vivienda: b })}>
          Es mi vivienda habitual
        </Toggle>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--muted)" }}>
          Cuándo y por cuánto lo compraste, o las tasaciones, los puedes añadir luego en
          su ficha.
        </p>
      </div>
    );
  }
  if (form.cajon === "bien") {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Field label="¿Cómo lo llamas?">
          <TextInput
            value={form.name}
            placeholder="Renault Clio"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="¿Cuánto vale?">
          <TextInput
            value={form.amount}
            placeholder="8.500 €"
            inputMode="decimal"
            onChange={(e) => set({ amount: e.target.value })}
          />
        </Field>
        <Field label="¿Qué es?" hint="(opcional)">
          <ChipRow
            options={BIEN_TIPOS}
            value={form.bienTipo}
            onChange={(v) => set({ bienTipo: v })}
          />
        </Field>
      </div>
    );
  }
  if (form.cajon === "deuda") {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Field label="¿Qué tipo de deuda?">
          <ChipRow
            options={DEUDA_TIPOS}
            value={form.deudaTipo}
            onChange={(v) => set({ deudaTipo: v })}
          />
        </Field>
        <Field label="¿Cómo la llamas?">
          <TextInput
            value={form.name}
            placeholder="Hipoteca de casa"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="¿Cuánto debes ahora?">
          <TextInput
            value={form.amount}
            placeholder="120.000 €"
            inputMode="decimal"
            onChange={(e) => set({ amount: e.target.value })}
          />
        </Field>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--muted)" }}>
          El cuadro de amortización y vincularla con tu casa se añaden luego en su ficha.
        </p>
      </div>
    );
  }
  if (form.cajon === "inversion") {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Field label="¿Qué clase de inversión es?">
          <ChipRow
            options={INV_GROUPS}
            value={form.invGroup}
            onChange={(v) => set({ invGroup: v, invSymbol: "", invPriceLive: null })}
          />
        </Field>
        {form.invGroup ? (
          <>
            <MockSymbolSearch form={form} set={set} />
            <Field label="¿Cómo la llamas?" hint="(puedes ajustar el nombre)">
              <TextInput
                value={form.name}
                placeholder="Fondo indexado mundial"
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <InvestmentAmount form={form} set={set} />
          </>
        ) : null}
      </div>
    );
  }
  return null;
}

// La bifurcación clave: saldo de hoy vs importar extracto (excluyentes)
function InvestmentAmount({
  form,
  set,
}: {
  form: Form;
  set: (patch: Partial<Form>) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <span style={{ fontWeight: 600 }}>¿Cómo metemos cuánto tienes?</span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {(
          [
            {
              id: "saldo",
              t: "Dime el saldo de hoy",
              d: "Rápido. Pones lo que tienes ahora en €.",
            },
            {
              id: "import",
              t: "Tengo el extracto (MyInvestor)",
              d: "Sube el CSV y se calcula todo solo.",
            },
          ] as const
        ).map((o) => {
          const active = form.invMode === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => set({ invMode: o.id })}
              style={{
                font: "inherit",
                textAlign: "left",
                cursor: "pointer",
                padding: 14,
                borderRadius: "var(--radius-sm)",
                border: active ? "2px solid var(--ink)" : "1px solid var(--line-strong)",
                background: active
                  ? "color-mix(in srgb, var(--green) 8%, var(--paper))"
                  : "var(--paper)",
                color: "var(--ink)",
              }}
            >
              <strong style={{ display: "block" }}>{o.t}</strong>
              <small style={{ color: "var(--muted)" }}>{o.d}</small>
            </button>
          );
        })}
      </div>
      {form.invMode === "saldo" ? (
        <Field label="¿Cuánto tienes ahora?" hint="en euros">
          <TextInput
            value={form.amount}
            placeholder="5.000 €"
            inputMode="decimal"
            onChange={(e) => set({ amount: e.target.value })}
          />
          {form.invPriceLive && toNum(form.amount) > 0 ? (
            <small style={{ color: "var(--muted)" }}>
              ≈{" "}
              {new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 }).format(
                toNum(form.amount) / form.invPriceLive,
              )}{" "}
              participaciones a {eur(form.invPriceLive)}/ud (lo calculamos solos)
            </small>
          ) : null}
        </Field>
      ) : null}
      {form.invMode === "import" ? (
        <div style={{ ...card, padding: 14, borderStyle: "dashed" }}>
          <strong>Subir extracto de MyInvestor</strong>
          <p style={{ margin: "6px 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
            (Prototipo: aquí va el flujo real de «Cargar movimientos» — vista previa «N
            nuevas · M sobrescritas» y confirmar. No sube de verdad en el prototipo.)
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variante A — Asistente a pantalla completa (una pregunta por pantalla)
// ---------------------------------------------------------------------------
type Step = "intro" | "pick" | "fields" | "owner" | "done";

function VariantA({ form, set, reset, added, add }: VariantProps) {
  const [step, setStep] = useState<Step>("intro");
  const [household, setHousehold] = useState<boolean | null>(null);

  const sequence: Step[] =
    household === false
      ? ["intro", "pick", "fields", "done"]
      : ["intro", "pick", "fields", "owner", "done"];
  const idx = sequence.indexOf(step);
  const go = (s: Step) => setStep(s);
  const next = () => go(sequence[Math.min(idx + 1, sequence.length - 1)]!);
  const back = () => (idx > 0 ? go(sequence[idx - 1]!) : undefined);

  const canNextFields =
    !!form.name &&
    (form.cajon !== "inversion" || (!!form.invGroup && !!form.invMode)) &&
    (form.cajon !== "deuda" || !!form.deudaTipo);

  const finish = () => {
    add();
    go("done");
  };

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "var(--paper)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "min(560px, 100%)", display: "grid", gap: 24 }}>
        {/* progreso + atrás */}
        {step !== "intro" && step !== "done" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button
              type="button"
              onClick={back}
              style={{
                font: "inherit",
                border: "none",
                background: "none",
                cursor: "pointer",
                color: "var(--blue)",
              }}
            >
              ← Atrás
            </button>
            <div style={{ display: "flex", gap: 6 }}>
              {sequence.slice(1, -1).map((s, i) => (
                <span
                  key={s}
                  style={{
                    width: 28,
                    height: 5,
                    borderRadius: 3,
                    background: i <= idx - 1 ? "var(--ink)" : "var(--line-soft)",
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}

        {step === "intro" ? (
          <div style={{ display: "grid", gap: 20, textAlign: "center" }}>
            <div style={{ fontSize: "3rem" }}>👋</div>
            <h1 style={{ margin: 0, fontSize: "1.7rem", color: "var(--ink)" }}>
              Vamos a montar tu patrimonio
            </h1>
            <p style={{ margin: 0, color: "var(--muted)" }}>
              Apuntamos lo que tienes, una cosa cada vez. Sin prisa.
            </p>
            <p style={{ margin: "8px 0 0", fontWeight: 600, color: "var(--ink)" }}>
              ¿Lo llevas tú solo o sois varios en casa?
            </p>
            <div style={{ display: "grid", gap: 10 }}>
              <PrimaryButton
                onClick={() => {
                  setHousehold(false);
                  set({ owner: "mio" });
                  go("pick");
                }}
              >
                Lo llevo yo solo
              </PrimaryButton>
              <GhostButton
                onClick={() => {
                  setHousehold(true);
                  set({ owner: "medios" });
                  go("pick");
                }}
              >
                Somos varios en casa
              </GhostButton>
            </div>
            <small style={{ color: "var(--muted)" }}>
              ¿Ya tienes una copia de worthline? Impórtala →
            </small>
          </div>
        ) : null}

        {step === "pick" ? (
          <div style={{ display: "grid", gap: 16 }}>
            <h2 style={{ margin: 0, fontSize: "1.4rem", color: "var(--ink)" }}>
              ¿Qué quieres apuntar?
            </h2>
            <div style={{ display: "grid", gap: 10 }}>
              {CAJONES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    set({ cajon: c.id });
                    go("fields");
                  }}
                  style={{
                    ...card,
                    font: "inherit",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: 16,
                    display: "flex",
                    gap: 14,
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: "1.8rem" }}>{c.icon}</span>
                  <span style={{ display: "grid" }}>
                    <strong style={{ color: "var(--ink)", fontSize: "1.05rem" }}>
                      {c.label}
                    </strong>
                    <small style={{ color: "var(--muted)" }}>{c.blurb}</small>
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: c.tier,
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === "fields" ? (
          <div style={{ display: "grid", gap: 22 }}>
            <h2 style={{ margin: 0, fontSize: "1.4rem", color: "var(--ink)" }}>
              {cajonOf(form.cajon)?.icon} {cajonOf(form.cajon)?.label}
            </h2>
            <CajonFields form={form} set={set} />
            <PrimaryButton onClick={next} disabled={!canNextFields}>
              Siguiente
            </PrimaryButton>
          </div>
        ) : null}

        {step === "owner" ? (
          <div style={{ display: "grid", gap: 22 }}>
            <h2 style={{ margin: 0, fontSize: "1.4rem", color: "var(--ink)" }}>
              ¿De quién es?
            </h2>
            <OwnershipControl value={form.owner} onChange={(v) => set({ owner: v })} />
            <PrimaryButton onClick={finish}>Añadir al patrimonio</PrimaryButton>
          </div>
        ) : null}

        {step === "done" ? (
          <SuccessPanel
            form={form}
            added={added}
            onAddAnother={() => {
              reset();
              go("pick");
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function SuccessPanel({
  form,
  added,
  onAddAnother,
}: {
  form: Form;
  added: AddedItem[];
  onAddAnother: () => void;
}) {
  const total = added.reduce((s, a) => s + a.amount, 0);
  const last = added[added.length - 1];
  const isInv = form.cajon === "inversion";
  return (
    <div style={{ display: "grid", gap: 18, textAlign: "center" }}>
      <div style={{ fontSize: "2.6rem" }}>✓</div>
      <h2 style={{ margin: 0, color: "var(--ink)" }}>
        {last ? `"${last.name}" añadido` : "Hecho"}
      </h2>
      <div style={{ ...card, padding: 16 }}>
        <small
          style={{
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontSize: "0.7rem",
          }}
        >
          Tu patrimonio va sumando
        </small>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "1.8rem",
            fontWeight: 700,
            color: "var(--ink)",
          }}
        >
          {eur(total)}
        </div>
        <small style={{ color: "var(--muted)" }}>
          {added.length} cosa{added.length === 1 ? "" : "s"} apuntada
          {added.length === 1 ? "" : "s"}
        </small>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        <PrimaryButton onClick={onAddAnother}>Añadir otra cosa</PrimaryButton>
        {isInv ? (
          <GhostButton onClick={onAddAnother}>
            Añadir más movimientos / importar extracto
          </GhostButton>
        ) : null}
        <GhostButton onClick={onAddAnother}>Ver mi patrimonio</GhostButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variante B — Una sola página que se revela
// ---------------------------------------------------------------------------
function VariantB({ form, set, reset, added, add }: VariantProps) {
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const total = added.reduce((s, a) => s + a.amount, 0);
  const canAdd =
    !!form.cajon &&
    !!form.name &&
    (form.cajon !== "inversion" || (!!form.invGroup && !!form.invMode)) &&
    (form.cajon !== "deuda" || !!form.deudaTipo);

  const doAdd = () => {
    const n = form.name;
    add();
    reset();
    setJustAdded(n);
  };

  return (
    <div
      style={{ minHeight: "100dvh", background: "var(--paper)", padding: "32px 24px" }}
    >
      <div
        style={{ width: "min(680px, 100%)", margin: "0 auto", display: "grid", gap: 20 }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--ink)" }}>
            Añade algo a tu patrimonio
          </h1>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            {eur(total)} · {added.length} cosas
          </span>
        </header>

        {justAdded ? (
          <p
            style={{
              ...card,
              margin: 0,
              padding: "10px 14px",
              color: "var(--green)",
              borderColor: "var(--green)",
            }}
            role="status"
          >
            ✓ «{justAdded}» añadido. Añade otra cosa abajo o termina cuando quieras.
          </p>
        ) : null}

        <div style={{ display: "grid", gap: 10 }}>
          <span style={{ fontWeight: 600, color: "var(--ink)" }}>¿Qué es?</span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 8,
            }}
          >
            {CAJONES.map((c) => {
              const active = form.cajon === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => set({ cajon: c.id })}
                  style={{
                    ...card,
                    font: "inherit",
                    cursor: "pointer",
                    padding: 12,
                    textAlign: "center",
                    border: active
                      ? "2px solid var(--ink)"
                      : "1px solid var(--line-soft)",
                  }}
                >
                  <div style={{ fontSize: "1.6rem" }}>{c.icon}</div>
                  <strong style={{ color: "var(--ink)", fontSize: "0.92rem" }}>
                    {c.label}
                  </strong>
                </button>
              );
            })}
          </div>
        </div>

        {form.cajon ? (
          <div style={{ ...card, padding: 20, display: "grid", gap: 20 }}>
            <CajonFields form={form} set={set} />
            <div
              style={{
                borderTop: "1px solid var(--hairline)",
                paddingTop: 16,
                display: "grid",
                gap: 8,
              }}
            >
              <span style={{ fontWeight: 600, color: "var(--ink)" }}>¿De quién es?</span>
              <OwnershipControl value={form.owner} onChange={(v) => set({ owner: v })} />
            </div>
          </div>
        ) : (
          <p style={{ color: "var(--muted)" }}>
            Elige arriba qué quieres apuntar y aquí aparecerá lo justo que hay que
            rellenar.
          </p>
        )}

        <div style={{ position: "sticky", bottom: 16, display: "flex", gap: 12 }}>
          <PrimaryButton onClick={doAdd} disabled={!canAdd}>
            Añadir al patrimonio
          </PrimaryButton>
          <GhostButton onClick={() => alert("(prototipo) ir al dashboard")}>
            Ya está, ver mi patrimonio
          </GhostButton>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variante C — Dos paneles: rail de cajones + lienzo con tarjeta-previa amable
// ---------------------------------------------------------------------------
function VariantC({ form, set, reset, added, add }: VariantProps) {
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const total = added.reduce((s, a) => s + a.amount, 0);
  const canAdd =
    !!form.cajon &&
    !!form.name &&
    (form.cajon !== "inversion" || (!!form.invGroup && !!form.invMode)) &&
    (form.cajon !== "deuda" || !!form.deudaTipo);
  const doAdd = () => {
    const n = form.name;
    add();
    reset();
    setJustAdded(n);
  };
  const amount = toNum(form.amount);

  return (
    <div style={{ minHeight: "100dvh", background: "var(--paper)", padding: 24 }}>
      <div
        style={{ width: "min(980px, 100%)", margin: "0 auto", display: "grid", gap: 18 }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "1.4rem", color: "var(--ink)" }}>
            Añadir a tu patrimonio
          </h1>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            {eur(total)} · {added.length} cosas
          </span>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "240px 1fr",
            gap: 18,
            alignItems: "start",
          }}
        >
          {/* rail */}
          <nav style={{ display: "grid", gap: 8 }}>
            {CAJONES.map((c) => {
              const active = form.cajon === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => set({ cajon: c.id })}
                  style={{
                    font: "inherit",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: "12px 14px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid",
                    borderColor: active ? "var(--ink)" : "var(--line-soft)",
                    background: active ? "var(--panel)" : "transparent",
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: "1.3rem" }}>{c.icon}</span>
                  <strong style={{ color: "var(--ink)", fontSize: "0.95rem" }}>
                    {c.label}
                  </strong>
                  <span
                    style={{
                      marginLeft: "auto",
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      background: c.tier,
                    }}
                  />
                </button>
              );
            })}
          </nav>

          {/* lienzo */}
          <div style={{ display: "grid", gap: 16 }}>
            {justAdded ? (
              <p
                style={{
                  ...card,
                  margin: 0,
                  padding: "10px 14px",
                  color: "var(--green)",
                  borderColor: "var(--green)",
                }}
                role="status"
              >
                ✓ «{justAdded}» añadido.
              </p>
            ) : null}

            {form.cajon ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 280px",
                  gap: 16,
                  alignItems: "start",
                }}
              >
                <div style={{ ...card, padding: 20, display: "grid", gap: 18 }}>
                  <CajonFields form={form} set={set} />
                  <div
                    style={{
                      borderTop: "1px solid var(--hairline)",
                      paddingTop: 14,
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontWeight: 600, color: "var(--ink)" }}>
                      ¿De quién es?
                    </span>
                    <OwnershipControl
                      value={form.owner}
                      onChange={(v) => set({ owner: v })}
                    />
                  </div>
                </div>

                {/* tarjeta-previa amable (NO el readout técnico) */}
                <aside
                  style={{
                    ...card,
                    padding: 18,
                    display: "grid",
                    gap: 10,
                    position: "sticky",
                    top: 16,
                  }}
                >
                  <small
                    style={{
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontSize: "0.7rem",
                    }}
                  >
                    Vas a añadir
                  </small>
                  <div style={{ fontSize: "2rem" }}>{cajonOf(form.cajon)?.icon}</div>
                  <strong style={{ color: "var(--ink)", fontSize: "1.1rem" }}>
                    {form.name || cajonOf(form.cajon)?.label}
                  </strong>
                  {amount > 0 ? (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "1.3rem",
                        color: form.cajon === "deuda" ? "var(--red)" : "var(--ink)",
                      }}
                    >
                      {form.cajon === "deuda" ? "−" : ""}
                      {eur(amount)}
                    </span>
                  ) : null}
                  <span style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
                    {ownerLabel(form.owner)}
                  </span>
                  <PrimaryButton onClick={doAdd} disabled={!canAdd}>
                    Añadir
                  </PrimaryButton>
                </aside>
              </div>
            ) : (
              <p style={{ color: "var(--muted)" }}>
                Elige a la izquierda qué quieres apuntar.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tipos + raíz: estado compartido + switcher flotante
// ---------------------------------------------------------------------------
interface VariantProps {
  form: Form;
  set: (patch: Partial<Form>) => void;
  reset: () => void;
  added: AddedItem[];
  add: () => void;
}

export default function WizardPrototype({ variant }: { variant: Variant }) {
  const router = useRouter();
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [added, setAdded] = useState<AddedItem[]>([]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const reset = () => setForm((f) => ({ ...EMPTY_FORM, owner: f.owner }));
  const add = () => {
    if (!form.cajon) return;
    setAdded((a) => [
      ...a,
      {
        cajon: form.cajon!,
        name: form.name || cajonOf(form.cajon)?.label || "—",
        amount: toNum(form.amount),
        owner: form.owner,
      },
    ]);
  };

  const props: VariantProps = { form, set, reset, added, add };

  const goVariant = (v: Variant) =>
    router.replace(`/patrimonio/anadir/prototipo?variant=${v}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = VARIANTS.indexOf(variant);
        const nx =
          e.key === "ArrowRight"
            ? (i + 1) % VARIANTS.length
            : (i - 1 + VARIANTS.length) % VARIANTS.length;
        goVariant(VARIANTS[nx]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  return (
    <>
      {variant === "A" && <VariantA {...props} />}
      {variant === "B" && <VariantB {...props} />}
      {variant === "C" && <VariantC {...props} />}
      {process.env.NODE_ENV !== "production" ? (
        <Switcher variant={variant} go={goVariant} />
      ) : null}
    </>
  );
}

function Switcher({ variant, go }: { variant: Variant; go: (v: Variant) => void }) {
  const i = VARIANTS.indexOf(variant);
  const cycle = (d: 1 | -1) => go(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length]!);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        borderRadius: 999,
        background: "#111",
        color: "#fff",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        zIndex: 9999,
        fontSize: "0.85rem",
      }}
    >
      <button
        type="button"
        onClick={() => cycle(-1)}
        style={{
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "1.1rem",
        }}
      >
        ←
      </button>
      <span style={{ fontWeight: 700 }}>
        {variant}{" "}
        <span style={{ opacity: 0.7, fontWeight: 400 }}>— {VARIANT_NAME[variant]}</span>
      </span>
      <button
        type="button"
        onClick={() => cycle(1)}
        style={{
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "1.1rem",
        }}
      >
        →
      </button>
    </div>
  );
}
