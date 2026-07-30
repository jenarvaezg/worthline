import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleFindHoldings } from "@web/agent-view/http";
import type { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<NextResponse> {
  const { scopeId } = await params;
  return handleFindHoldings(request, scopeId, runAgentViewStore);
}
