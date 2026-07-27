import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleGetMemberProfiles } from "@web/agent-view/http";
import type { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleGetMemberProfiles(request, runAgentViewStore);
}
