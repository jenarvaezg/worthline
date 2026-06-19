import { NextResponse, type NextRequest } from "next/server";

import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";
import { parsePersonaId } from "@web/demo/persona";
import { SCOPE_COOKIE_NAME } from "@web/intake";

/**
 * Persona cookie route (PRD #297), mirroring `/scope/route.ts`. Sets the
 * `wl_demo_persona` cookie and CLEARS `wl_scope` — a stale member scope must not
 * point at a persona that lacks that member — then redirects into the app.
 *
 * GET serves the shareable deep-link (`/demo/persona?persona=…`); POST serves the
 * landing's selection forms. An unknown/absent persona falls back to familia.
 */
function selectPersona(raw: string | null): NextResponse {
  const persona = parsePersonaId(raw);
  // A RELATIVE Location ("/") so the browser resolves it against the host it is
  // already on. An absolute redirect can switch host (127.0.0.1 ⇄ localhost, or a
  // proxy origin), and the freshly-set cookie — scoped to the request host —
  // would not be sent to the new host, silently dropping the persona switch.
  const response = new NextResponse(null, { status: 303, headers: { Location: "/" } });
  response.cookies.set(DEMO_PERSONA_COOKIE_NAME, persona, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
  });
  response.cookies.delete(SCOPE_COOKIE_NAME);
  return response;
}

export function GET(request: NextRequest): NextResponse {
  return selectPersona(request.nextUrl.searchParams.get("persona"));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  return selectPersona(String(formData.get("persona") ?? ""));
}
