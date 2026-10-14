/**
 * GET /ajustes/export — download the whole workspace as a JSON file.
 *
 * Serializes the entire workspace (ADR 0010) into the versioned export
 * document and serves it as an attachment, so the browser saves a file
 * instead of navigating. Pretty-printed on purpose: the export is the manual
 * stand-in for backup/sync, and a human should be able to read it.
 *
 * A viewer of a shared workspace gets 403 before the store opens (#1843, ADR
 * 0112): the export is the owner's copy and would survive a revocation.
 */

import { viewsSharedWorkspace } from "@web/demo/write-guard";
import { readStoreTarget } from "@web/read-store-target";
import { withStore } from "@web/store";
import { redirect } from "next/navigation";

/** Today's date in the server's local time zone, as YYYY-MM-DD. */
function localDateStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What a viewer reads if it reaches the export anyway (a typed or old link). */
const VIEWER_EXPORT_MESSAGE =
  "La exportación es solo para quien es dueño del espacio. Con acceso de solo lectura puedes ver sus cifras aquí, pero no descargarlas.";

export async function GET(): Promise<Response> {
  if (viewsSharedWorkspace(await readStoreTarget())) {
    return new Response(VIEWER_EXPORT_MESSAGE, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      status: 403,
    });
  }

  const doc = await withStore(async (store) =>
    (await store.workspace.readWorkspace()) === null
      ? null
      : store.workspace.exportWorkspace(),
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
