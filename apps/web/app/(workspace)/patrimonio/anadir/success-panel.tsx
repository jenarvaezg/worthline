"use client";

import { holdingOperationsHref } from "@web/holding-route";
import Link from "next/link";
import { useEffect, useRef } from "react";

/**
 * The add wizard's success screen with a loop (S5, #600). After each alta the
 * action returns here instead of the holdings list, so first runs chain adds
 * without friction: the running net worth is the hook, «Añadir otra» restarts
 * the loop, «Ver mi patrimonio» exits. Investments also offer the movements
 * surface already unfolded (`?abrir=operaciones`): that block lives inside
 * collapsed «Configuración avanzada», so the ficha alone would show nothing.
 * A client island only so it can manage focus — moving it to the result
 * heading when the screen lands (a11y: the user is never stranded at the top).
 *
 * `notice` is the one thing here that is NOT a celebration (#1561): a question
 * about the data that just went in. It gets its own aviso band under the title,
 * never the green heading, because the honest answer may be «no, corrígela».
 */
export function AddSuccessPanel({
  addedId,
  isInvestment,
  message,
  netWorthLabel,
  notice,
}: {
  /** The new holding's public `wl_hld_…` id (#1318) — what the action redirects with. */
  addedId: string | undefined;
  isInvestment: boolean;
  message: string;
  netWorthLabel: string;
  /** A non-blocking question about what was just saved (#1561), when there is one. */
  notice?: string | null;
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
      {notice ? (
        <p className="warningBand addSuccessNotice" role="note">
          {notice}
        </p>
      ) : null}
      <p className="addSuccessTotal">
        Patrimonio neto <strong>{netWorthLabel}</strong>
      </p>
      <div className="addSuccessActions">
        <Link className="primaryAction" href="/patrimonio/anadir">
          + Añadir otra
        </Link>
        {isInvestment && addedId ? (
          <Link className="actionLink" href={holdingOperationsHref(addedId)}>
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
