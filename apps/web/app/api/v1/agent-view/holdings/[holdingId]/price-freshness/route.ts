import { withStore } from "@worthline/db";
import type { NextRequest, NextResponse } from "next/server";

import { handleGetPriceFreshness } from "@web/agent-view/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ holdingId: string }> },
): Promise<NextResponse> {
  const { holdingId } = await params;
  return handleGetPriceFreshness(request, holdingId, withStore);
}
