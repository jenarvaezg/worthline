import { PRIVACY_COOKIE_NAME } from "@web/intake";
import { parseReturnTo, seeOtherRedirect } from "@web/return-to";
import type { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const rawReturnTo = String(formData.get("returnTo") ?? "").trim();
  const returnTo = parseReturnTo(rawReturnTo);

  const isPrivacyMode = request.cookies.get(PRIVACY_COOKIE_NAME)?.value === "1";

  const response = seeOtherRedirect(returnTo);

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
