"use client";

import { usePathname } from "next/navigation";

import { impersonationBandCopy } from "./impersonation-band-copy";

/**
 * The impersonation band's presentation (#1732), split off from the server
 * component that reads the cookie.
 *
 * A client island for one reason: the band is mounted from the root layout, which
 * knows nothing of the route below it, and what the band should SAY depends on
 * exactly that (see {@link impersonationBandCopy}). Same gate the assistant
 * launcher uses for its surface check — `usePathname()`, no navigation state of
 * its own. The exit control stays a real `<form>` posting to the server action,
 * so it works before this island hydrates.
 */
export function ImpersonationBand({
  email,
  stopAction,
}: {
  email: string;
  stopAction: () => void | Promise<void>;
}) {
  const { lead, trail } = impersonationBandCopy(usePathname() ?? "");

  return (
    <div
      aria-label="Impersonación de administrador"
      className="sessionBand"
      data-tone="warning"
      role="note"
    >
      <span>
        {lead}
        <strong>{email}</strong>
        {trail}
      </span>
      <form action={stopAction}>
        <button type="submit">Salir →</button>
      </form>
    </div>
  );
}
