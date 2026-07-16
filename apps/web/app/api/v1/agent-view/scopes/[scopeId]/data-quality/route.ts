import { handleGetDataQuality } from "@web/agent-view/http";
import { withStoreUnsafe } from "@worthline/db";
import type { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<NextResponse> {
  const { scopeId } = await params;
  return handleGetDataQuality(request, scopeId, withStoreUnsafe);
}
