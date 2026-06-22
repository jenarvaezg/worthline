import Link from "next/link";

import { PERSONA_META } from "@web/demo/persona";
import { readDemoContext } from "@web/demo/read-demo-context";

/**
 * The slim, persistent "Demo · datos ficticios" strip (PRD #297). Rendered on
 * every page in demo mode (from the root layout, gated by `isDemoMode()`), it
 * names the active persona and links back to /demo to switch. A status strip,
 * not a card — no panel chrome, muted text (mirrors the persistence footer).
 *
 * The exit control (#464) POSTs to `/demo/exit`, which clears the persona/scope
 * cookies and returns to /login. POST + server route, not a GET `<Link>` (ADR
 * 0009): Next's prefetch over a GET would fire the exit before any click.
 */
export default async function DemoBanner() {
  const { persona } = await readDemoContext();
  const meta = PERSONA_META[persona];

  return (
    <div className="demoBanner" role="note" aria-label="Modo demostración">
      <span>
        Demo · datos ficticios · <strong>{meta.label}</strong>
      </span>
      <Link href="/demo">cambiar persona →</Link>
      <form action="/demo/exit" method="post">
        <button type="submit">Salir de la demo →</button>
      </form>
    </div>
  );
}
