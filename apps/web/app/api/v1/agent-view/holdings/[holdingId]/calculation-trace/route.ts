import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleGetCalculationTrace } from "@web/agent-view/http";
import type { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ holdingId: string }> },
): Promise<NextResponse> {
  const { holdingId } = await params;
  return handleGetCalculationTrace(request, holdingId, runAgentViewStore);
}
