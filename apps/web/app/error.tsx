"use client";

import Link from "next/link";

type ErrorPageProps = {
  error: Error & { digest?: string };
  unstable_retry: () => void;
};

export default function ErrorPage({ unstable_retry }: ErrorPageProps) {
  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1 className="brandName">worthline</h1>
            <p>Patrimonio neto local</p>
          </div>
        </div>
      </header>

      <section className="section errorRecovery">
        <div className="errorBand" role="alert">
          <strong>No pudimos cargar esta vista</strong>
          <span>Puede ser un fallo temporal de la ruta. No hemos perdido tus datos.</span>
        </div>
        <p className="emptyLine">Reintenta la carga o vuelve al resumen.</p>
        <div className="errorActions">
          <button
            className="primaryAction"
            type="button"
            onClick={() => unstable_retry()}
          >
            Reintentar
          </button>
          <Link className="actionLink" href="/app">
            Volver al resumen
          </Link>
        </div>
      </section>
    </main>
  );
}
