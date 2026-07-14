import Link from "next/link";

// Remate en registro de cubierta (#829/#909): una URL fuera del libro no es
// una avería — tinta, filete dorado y la vuelta al resumen. Sin UI de trabajo.
export default function NotFound() {
  return (
    <main className="notFoundPage coverSurface">
      <div className="brand">
        <span className="brandMark" aria-hidden="true">
          wl
        </span>
        <div>
          <h1 className="brandName">worthline</h1>
          <p>Patrimonio neto local</p>
        </div>
      </div>

      <div className="notFoundBody">
        <h2>No encontramos esta página</h2>
        <p>La URL puede estar obsoleta o mal escrita.</p>
        <p>Vuelve al resumen para seguir navegando por worthline.</p>
        <Link className="actionLink" href="/app">
          Volver al resumen
        </Link>
      </div>
    </main>
  );
}
