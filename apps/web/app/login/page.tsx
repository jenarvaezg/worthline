import { auth, signIn } from "@web/auth";
import { parseReturnTo } from "@web/return-to";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Sign-in landing (ADR 0030). The public entry point when auth is enabled:
 * signed-out visitors can sign in with Google — or follow "probar la demo" into
 * the read-only public demo (no account needed). Successful sign-in sends them
 * to `returnTo` when valid, otherwise `/app`. Zero client JS (ADR 0009): a
 * server action POST.
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

  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    const session = await auth();
    if (session) {
      redirect(returnTo);
    }
  }

  return (
    <main className="loginPage">
      <div className="loginCard">
        <div className="brand loginBrand">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1>worthline</h1>
            <p>Patrimonio neto personal y familiar</p>
          </div>
        </div>

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: returnTo });
          }}
        >
          <button type="submit">Iniciar sesión con Google</button>
        </form>

        <p className="loginDemoLink">
          ¿Solo mirando? <Link href="/demo">Probar la demo →</Link>
        </p>
      </div>
    </main>
  );
}
