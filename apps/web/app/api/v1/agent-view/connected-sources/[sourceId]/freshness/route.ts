import { handleGetSourceFreshness } from "@web/agent-view/http";
import { withStore } from "@worthline/db";
import type { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> },
): Promise<NextResponse> {
  const { sourceId } = await params;
  return handleGetSourceFreshness(request, sourceId, withStore);
}
