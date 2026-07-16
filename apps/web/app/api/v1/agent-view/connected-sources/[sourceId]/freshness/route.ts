import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleGetSourceFreshness } from "@web/agent-view/http";
import type { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> },
): Promise<NextResponse> {
  const { sourceId } = await params;
  return handleGetSourceFreshness(request, sourceId, runAgentViewStore);
}
