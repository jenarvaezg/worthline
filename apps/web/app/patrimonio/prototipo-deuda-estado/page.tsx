import { notFound } from "next/navigation";

import DebtStatePrototype from "./debt-state-prototype";

export const metadata = {
  title: "Prototipo deuda por estado actual · worthline",
};

export default function CurrentStateDebtPrototypePage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <DebtStatePrototype />;
}
