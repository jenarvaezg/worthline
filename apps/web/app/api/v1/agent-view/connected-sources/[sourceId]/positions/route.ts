import { withStore } from "@worthline/db";
import type { NextRequest, NextResponse } from "next/server";

import { handleGetSourcePositions } from "../../../../../../agent-view/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> },
): Promise<NextResponse> {
  const { sourceId } = await params;
  return handleGetSourcePositions(request, sourceId, withStore);
}
