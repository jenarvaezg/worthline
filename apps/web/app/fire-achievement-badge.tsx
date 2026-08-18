import type { FireAchievement } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";

const BADGE_LABEL = {
  coast: "Coast FIRE alcanzado",
  fire: "FIRE alcanzado",
} as const;

/**
 * The FIRE achievement badge (#1449), drawn identically on the home glance and
 * the /objetivos hero.
 *
 * When the ledger measures dis-saving the badge is NOT removed — the capital
 * really is there — but it stops congratulating: it says "sobre el papel" in the
 * aviso register (`--gold`) and names the measured figure underneath. Hiding it
 * would leave the user with no explanation for a badge that disappeared; showing
 * it green would tell him a falsehood about where he is heading.
 */
export default function FireAchievementBadge({
  achievement,
  currency,
  privacyMode,
}: {
  achievement: FireAchievement;
  currency: string;
  privacyMode: boolean;
}) {
  if (achievement.level === null) {
    return null;
  }

  const label = BADGE_LABEL[achievement.level];

  if (!achievement.vetoed) {
    return <span className="statePill ready">{label}</span>;
  }

  const months = achievement.measuredMonths ?? 0;
  const measured = formatMoneyMinorPrivacy(
    { amountMinor: achievement.measuredMonthlySavingsMinor ?? 0, currency },
    privacyMode,
  );

  return (
    <>
      <span className="statePill caution">{label} sobre el papel</span>
      <p className="fireAchievementCaveat">
        Tu ahorro medido de los últimos {months} {months === 1 ? "mes" : "meses"} es{" "}
        <strong>{measured}</strong> al mes: tus operaciones dicen que te alejas del FIRE,
        no que te acerques.
      </p>
    </>
  );
}
