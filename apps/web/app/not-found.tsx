import Link from "next/link";

export default function NotFound() {
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

      <section className="summaryBand">
        <div className="panelHeader">
          <div>
            <h2>No encontramos esta página</h2>
            <span>La URL puede estar obsoleta o mal escrita.</span>
          </div>
        </div>
        <p className="emptyLine">
          Vuelve al resumen para seguir navegando por worthline.
        </p>
        <Link className="actionLink" href="/app">
          Volver al resumen
        </Link>
      </section>
    </main>
  );
}
