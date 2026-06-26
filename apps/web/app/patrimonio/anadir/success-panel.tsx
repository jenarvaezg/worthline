"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

/**
 * The add wizard's success screen with a loop (S5, #600). After each alta the
 * action returns here instead of the holdings list, so first runs chain adds
 * without friction: the running net worth is the hook, «Añadir otra» restarts
 * the loop, «Ver mi patrimonio» exits. Investments also offer the statement
 * route. A client island only so it can manage focus — moving it to the result
 * heading when the screen lands (a11y: the user is never stranded at the top).
 */
export function AddSuccessPanel({
  addedId,
  isInvestment,
  message,
  netWorthLabel,
}: {
  addedId: string | undefined;
  isInvestment: boolean;
  message: string;
  netWorthLabel: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="addSuccessPanel" role="status" aria-label="Alta completada">
      <h2 className="addSuccessTitle" ref={headingRef} tabIndex={-1}>
        ✓ {message}
      </h2>
      <p className="addSuccessTotal">
        Patrimonio neto <strong>{netWorthLabel}</strong>
      </p>
      <div className="addSuccessActions">
        <Link className="primaryAction" href="/patrimonio/anadir">
          + Añadir otra
        </Link>
        {isInvestment && addedId ? (
          <Link className="actionLink" href={`/patrimonio/${addedId}/editar`}>
            Añadir movimientos / Importar extracto
          </Link>
        ) : null}
        <Link className="actionLink" href="/patrimonio">
          Ver mi patrimonio →
        </Link>
      </div>
    </section>
  );
}
