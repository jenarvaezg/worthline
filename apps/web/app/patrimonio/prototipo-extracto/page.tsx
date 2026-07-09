import { notFound } from "next/navigation";

import MultiIsinStatementPrototype from "./multi-isin-statement-prototype";

export const metadata = {
  title: "Prototipo extracto multi-ISIN · worthline",
};

export default function PrototipoExtractoPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <MultiIsinStatementPrototype />;
}
