import { signIn } from "@web/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Sign-in landing (ADR 0030). The public entry point when auth is enabled:
 * signed-out visitors can sign in with Google — or follow "probar la demo" into
 * the read-only public demo (no account needed). Successful sign-in sends them
 * to the dashboard. Zero client JS (ADR 0009): a server action POST.
 */
export default function LoginPage() {
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
            await signIn("google", { redirectTo: "/" });
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
