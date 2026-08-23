import type { Section } from "./grouping";

/** Lo que recibe una variante: el tablero ya bucketeado y el estado de apertura. */
export interface VariantProps {
  assets: Section[];
  liabilities: Section[];
  open: boolean;
  onToggle: () => void;
}
