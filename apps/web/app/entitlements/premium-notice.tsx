/**
 * The reusable honest paywall (PRD #1160 S2, #1162): a permanent, non-blocking
 * reminder rendered as a paper "aviso" entry (design-system §1 gold/aviso
 * semantics), NEVER a wall in front of a read. Presentational only — no client
 * hooks, no server-only imports — so it renders identically in a Server
 * Component surface (settings, statement import) and inside the client
 * assistant panel (the `data-paywall` stream part).
 */

import { PREMIUM_CTA } from "./paywall-copy";

interface PremiumNoticeProps {
  /** The honest reminder text — one of the `PAYWALL_*` copy constants. */
  message: string;
  /**
   * Whether to render the call-to-action link (default true). Omitted on the
   * settings surface itself, where the CTA would just link back to the page.
   */
  cta?: boolean;
}

export function PremiumNotice({
  message,
  cta = true,
}: PremiumNoticeProps): React.JSX.Element {
  return (
    <aside className="premiumNotice" role="note">
      <p className="premiumNoticeText">{message}</p>
      {cta ? (
        <a className="btn premiumNoticeCta" href={PREMIUM_CTA.href}>
          {PREMIUM_CTA.label}
        </a>
      ) : null}
    </aside>
  );
}
