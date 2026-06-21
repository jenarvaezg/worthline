import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { PRIVACY_COOKIE_NAME } from "@web/intake";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const rawReturnTo = String(formData.get("returnTo") ?? "").trim();
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/";

  const jar = await cookies();
  const isPrivacyMode = jar.get(PRIVACY_COOKIE_NAME)?.value === "1";

  const response = NextResponse.redirect(new URL(returnTo, request.url), {
    status: 303,
  });

  if (isPrivacyMode) {
    response.cookies.delete(PRIVACY_COOKIE_NAME);
  } else {
    response.cookies.set(PRIVACY_COOKIE_NAME, "1", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  }

  return response;
}
