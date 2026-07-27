import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleListConnectedSources } from "@web/agent-view/http";
import type { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleListConnectedSources(request, runAgentViewStore);
}
