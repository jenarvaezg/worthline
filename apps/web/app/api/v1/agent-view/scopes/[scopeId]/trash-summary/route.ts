import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleGetTrashSummary } from "@web/agent-view/http";
import type { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<NextResponse> {
  const { scopeId } = await params;
  return handleGetTrashSummary(request, scopeId, runAgentViewStore);
}
