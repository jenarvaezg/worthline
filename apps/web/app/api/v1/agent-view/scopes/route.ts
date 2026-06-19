import { withStore } from "@worthline/db";
import type { NextRequest } from "next/server";

import { handleListScopes } from "../../../../agent-view/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest): ReturnType<typeof handleListScopes> {
  return handleListScopes(request, withStore);
}
