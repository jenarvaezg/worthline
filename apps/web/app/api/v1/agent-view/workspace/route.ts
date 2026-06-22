import { withStore } from "@worthline/db";
import type { NextRequest, NextResponse } from "next/server";

import { handleGetWorkspace } from "@web/agent-view/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleGetWorkspace(request, withStore);
}
