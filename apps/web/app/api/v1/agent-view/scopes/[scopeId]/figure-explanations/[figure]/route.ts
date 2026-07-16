import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleExplainFigure } from "@web/agent-view/http";
import type { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scopeId: string; figure: string }> },
): Promise<NextResponse> {
  const { figure, scopeId } = await params;
  return handleExplainFigure(request, scopeId, figure, runAgentViewStore);
}
