import { auth, signIn } from "@web/auth";
import { parseReturnTo } from "@web/return-to";
import Link from "next/link";
import { redirect } from "next/navigation";

/**
 * Block (#1229): this route opts out of Instant Navigations validation.
 * Soft-click shell prefetching is not the goal here — see the route table on
 * issue #1229 for the why.
 */
export const instant = false;

/**
 * Sign-in landing (ADR 0030). The public entry point when auth is enabled:
 * signed-out visitors can sign in with Google — or follow "probar la demo" into
 * the read-only public demo (no account needed). Successful sign-in sends them
 * to `returnTo` when valid, otherwise `/app`. Zero client JS (ADR 0009): a
 * server action POST. In local no-auth mode (no Google pair) the Google button
 * is disabled and a "Sesión local" entry leads into the app instead.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const rawReturnTo = Array.isArray(resolved?.returnTo)
    ? resolved?.returnTo[0]
    : resolved?.returnTo;
  const returnTo = parseReturnTo(rawReturnTo);

  // Local no-auth mode (ADR 0030): Google is absent, so there is no session to
  // resolve — the page advertises the local entry instead of a live sign-in.
  const authConfigured = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );

  if (authConfigured) {
    const session = await auth();
    if (session) {
      redirect(returnTo);
    }
  }

  return (
    // Umbral en registro de cubierta (#829/#909): la marca sobre la tinta,
    // la hoja luminosa como panel del formulario y el enlace a la demo.
    <main className="loginPage coverSurface">
      <div className="loginCover">
        <div className="brand loginBrand">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1>worthline</h1>
            <p>Patrimonio neto personal y familiar</p>
          </div>
        </div>

        <div className="loginCard coverSheet">
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: returnTo });
            }}
          >
            <button type="submit" disabled={!authConfigured}>
              Iniciar sesión con Google
            </button>
          </form>

          {!authConfigured && (
            <Link className="loginLocalBtn" href={returnTo}>
              Sesión local
            </Link>
          )}

          <p className="loginDemoLink">
            ¿Solo mirando? <Link href="/demo">Probar la demo →</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
