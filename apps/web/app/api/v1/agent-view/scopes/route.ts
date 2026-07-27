import { runAgentViewStore } from "@web/agent-view/agent-view-store";
import { handleListScopes } from "@web/agent-view/http";
import type { NextRequest } from "next/server";

export function GET(request: NextRequest): ReturnType<typeof handleListScopes> {
  return handleListScopes(request, runAgentViewStore);
}
