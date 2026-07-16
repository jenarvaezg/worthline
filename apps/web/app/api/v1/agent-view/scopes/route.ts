import { handleListScopes } from "@web/agent-view/http";
import { withStoreUnsafe } from "@worthline/db";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest): ReturnType<typeof handleListScopes> {
  return handleListScopes(request, withStoreUnsafe);
}
