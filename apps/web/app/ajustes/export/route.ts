/**
 * GET /ajustes/export — download the whole workspace as a JSON file.
 *
 * Serializes the entire workspace (ADR 0010) into the versioned export
 * document and serves it as an attachment, so the browser saves a file
 * instead of navigating. Pretty-printed on purpose: the export is the manual
 * stand-in for backup/sync, and a human should be able to read it.
 */

import { withStore } from "@worthline/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Today's date in the server's local time zone, as YYYY-MM-DD. */
function localDateStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function GET(): Response {
  const doc = withStore((store) =>
    store.readWorkspace() === null ? null : store.exportWorkspace(),
  );

  if (!doc) {
    redirect("/empezar");
  }

  const filename = `worthline-export-${localDateStamp(new Date())}.json`;

  return new Response(JSON.stringify(doc, null, 2), {
    headers: {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
