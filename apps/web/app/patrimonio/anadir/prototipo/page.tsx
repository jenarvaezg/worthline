// PROTOTIPO — throwaway. Asistente de alta de holdings (3 variantes, ?variant=A|B|C).
// Borrar cuando gane una variante; ver NOTES.md.
import WizardPrototype from "./wizard-prototype";

export const dynamic = "force-dynamic";

export default async function PrototipoPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = typeof sp?.variant === "string" ? sp.variant.toUpperCase() : "A";
  const variant = (raw === "B" || raw === "C" ? raw : "A") as "A" | "B" | "C";
  return <WizardPrototype variant={variant} />;
}
