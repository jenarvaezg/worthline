"use client";

/**
 * El único componente de cliente del carril de pago (#1221): carga Paddle.js
 * desde el CDN de Paddle y abre su checkout INLINE sobre una transacción que el
 * servidor ya creó. Es lo mínimo imprescindible para que Paddle cobre: no
 * pintamos campos de tarjeta ni tocamos datos de pago, el iframe de Paddle es
 * quien los recoge (contrato #1135, «cero UI de facturación propia»).
 *
 * Vive en su propia ruta a propósito: la CSP que este iframe necesita
 * (`script-src`/`connect-src`/`frame-src` de Paddle) está ensanchada SOLO aquí
 * —ver `security-headers.ts`—, así que el resto de la app sigue con la política
 * cerrada de #1256/#1273.
 */

import { initializePaddle } from "@paddle/paddle-js";
import { useEffect, useState } from "react";

/**
 * La CLASE del div que Paddle.js rellena con su iframe. Clase y no id: Paddle.js
 * resuelve `frameTarget` por `className`, y con un id lanza «Cannot read
 * properties of undefined (reading 'appendChild')» — medido, no leído.
 */
const FRAME_TARGET = "paddle-checkout-frame";

export default function PaddleCheckout({ transactionId }: { transactionId: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    initializePaddle({
      token,
      environment:
        process.env.NEXT_PUBLIC_PADDLE_ENV === "production" ? "production" : "sandbox",
      checkout: {
        settings: {
          displayMode: "inline",
          frameTarget: FRAME_TARGET,
          frameInitialHeight: 450,
          frameStyle: "width:100%;min-width:312px;background:transparent;border:none",
        },
      },
    })
      .then((paddle) => {
        if (cancelled || !paddle) {
          // Sin instancia no hay checkout: pasa si el script no carga (red o
          // CSP). Decirlo es mejor que dejar un hueco girando.
          if (!cancelled) setFailed(true);
          return;
        }
        paddle.Checkout.open({ transactionId });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  if (failed) {
    return (
      <p className="muted">
        No se ha podido abrir la pasarela de pago. Tu plan y tus datos no cambian;
        inténtalo de nuevo en un momento.
      </p>
    );
  }

  return <div className={FRAME_TARGET} />;
}
