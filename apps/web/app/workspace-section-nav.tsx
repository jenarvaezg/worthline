import { viewsSharedWorkspace } from "@web/demo/write-guard";
import { readStoreTarget } from "@web/read-store-target";
import SectionNav from "@web/section-nav";

/**
 * The topnav as this session may use it (#1844): the server half that asks the
 * classifier whether the session views someone else's workspace, so «Ajustes»
 * is not offered to a viewer. Streams inside the layout's `Suspense`, whose
 * fallback paints the five static tabs; a viewer who clicks «Ajustes» in that
 * instant lands on /app anyway (the page redirects).
 */
export default async function WorkspaceSectionNav() {
  return (
    <SectionNav viewingSharedWorkspace={viewsSharedWorkspace(await readStoreTarget())} />
  );
}
