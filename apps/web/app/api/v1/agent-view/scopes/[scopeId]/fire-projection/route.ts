import { withStore } from "@worthline/db";
import type { NextRequest, NextResponse } from "next/server";

import { handleGetFireProjection } from "@web/agent-view/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<NextResponse> {
  const { scopeId } = await params;
  return handleGetFireProjection(request, scopeId, withStore);
}
