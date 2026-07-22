/**
 * Internal, deliberately-unsafe store openers (#1123, PRD #998 S1 / decision #892).
 *
 * The two raw openers resolve a workspace database with NO authorization — they
 * ignore the caller's principal entirely. They are kept OFF the public
 * `@worthline/db` barrel so no ordinary importer can reach them by accident;
 * this subpath (`@worthline/db/unsafe-store`) is the ONLY way to import them
 * from outside the package. The one authorized request-side importer is the web
 * authorization port (`apps/web/app/principal.ts`, `withAuthorizedStore`);
 * non-request callers that legitimately bring their own coordinates — cron,
 * scripts, migrations, tests — import it directly too.
 */
export { createWorthlineStoreUnsafe, withStoreUnsafe } from "./store-opener";
