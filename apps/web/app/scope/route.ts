import { appendParam, SCOPE_COOKIE_NAME } from "@web/intake";
import { parseReturnTo, seeOtherRedirect } from "@web/return-to";
import type { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const scopeId = String(formData.get("scopeId") ?? "").trim();
  const rawReturnTo = String(formData.get("returnTo") ?? "").trim();
  const returnTo = parseReturnTo(rawReturnTo);

  const scopedReturnTo = scopeId ? appendParam(returnTo, "scope", scopeId) : returnTo;
  const response = seeOtherRedirect(scopedReturnTo);

  if (scopeId) {
    response.cookies.set(SCOPE_COOKIE_NAME, scopeId, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  }

  return response;
}
