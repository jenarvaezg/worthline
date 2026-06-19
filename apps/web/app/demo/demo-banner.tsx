import Link from "next/link";

import { PERSONA_META } from "@web/demo/persona";
import { readDemoContext } from "@web/demo/read-demo-context";

/**
 * The slim, persistent "Demo · datos ficticios" strip (PRD #297). Rendered on
 * every page in demo mode (from the root layout, gated by `isDemoMode()`), it
 * names the active persona and links back to /demo to switch. A status strip,
 * not a card — no panel chrome, muted text (mirrors the persistence footer).
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
    </div>
  );
}
