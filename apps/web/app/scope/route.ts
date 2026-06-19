import { NextResponse, type NextRequest } from "next/server";

import { appendParam, SCOPE_COOKIE_NAME } from "@web/intake";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const scopeId = String(formData.get("scopeId") ?? "").trim();
  const rawReturnTo = String(formData.get("returnTo") ?? "").trim();
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/";

  const scopedReturnTo = scopeId ? appendParam(returnTo, "scope", scopeId) : returnTo;
  const response = NextResponse.redirect(new URL(scopedReturnTo, request.url), {
    status: 303,
  });

  if (scopeId) {
    response.cookies.set(SCOPE_COOKIE_NAME, scopeId, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  }

  return response;
}
