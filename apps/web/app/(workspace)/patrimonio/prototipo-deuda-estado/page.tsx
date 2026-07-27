import { notFound } from "next/navigation";
import DebtStatePrototype from "./debt-state-prototype";

/**
 * Block (#1229): this route opts out of Instant Navigations validation.
 * Soft-click shell prefetching is not the goal here — see the route table on
 * issue #1229 for the why.
 */
export const instant = false;

export const metadata = {
  title: "Prototipo deuda por estado actual · worthline",
};

export default function CurrentStateDebtPrototypePage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <DebtStatePrototype />;
}
