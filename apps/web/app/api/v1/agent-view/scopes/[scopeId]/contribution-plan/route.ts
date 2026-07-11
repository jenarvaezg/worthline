import { handleGetContributionPlan } from "@web/agent-view/http";
import { withStore } from "@web/store";
import type { NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ scopeId: string }> },
) {
  const { scopeId } = await context.params;
  return handleGetContributionPlan(request, scopeId, withStore);
}
