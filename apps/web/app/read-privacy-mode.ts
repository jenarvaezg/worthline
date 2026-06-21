import { cookies } from "next/headers";
import { cache } from "react";

import { parsePrivacyCookie, PRIVACY_COOKIE_NAME } from "./intake";

/**
 * Request-scoped privacy mode reader. Lets server components and surfaces read
 * the cookie without every page having to prop-drill it through the tree.
 */
export const getPrivacyMode = cache(async (): Promise<boolean> => {
  const jar = await cookies();
  return parsePrivacyCookie(jar.get(PRIVACY_COOKIE_NAME)?.value);
});
