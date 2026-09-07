/**
 * How the identifier field READS, per kind (#1746, decisión 9 del mapa #1454): its
 * words, and what its box shows for a given stored value.
 *
 * One field asks two different questions. A fund/ETF/stock is identified by its
 * ISIN; a Spanish pension plan has no ISIN at all — its identifier is the DGS code
 * (`N####`), and asking a partícipe for an ISIN was the impossible task of #1489.
 *
 * The copy lives apart from the components because THREE surfaces say it: the
 * simple alta, the advanced alta and the ficha. A second table would be a second
 * vocabulary, and the plan's trap — the paper prints the FONDO's code (`F####`)
 * next to the plan's — is exactly the sentence that must not exist in only two of
 * the three places.
 *
 * The label itself is the domain's ({@link SECURITY_ID_KIND_LABEL}): it is the same
 * word a diff row and the assistant's refusal use.
 */

import {
  SECURITY_ID_KIND_LABEL,
  SECURITY_ID_KIND_LABEL_INLINE,
  type SecurityIdKind,
  type StoredSecurityId,
} from "@worthline/domain";

export interface SecurityIdFieldCopy {
  /**
   * The button that turns this identifier into a search, where it seeds one
   * (variante A de #1669). Null where nothing is searched by identifier: the
   * ISIN's own search box asks by name/ISIN and is a different control.
   */
  searchLabel: string | null;
  /** The field's own label — the alta's, which names the instrument it belongs to. */
  altaLabel: string;
  /** The ficha's label: the identifier's name, with no «del plan» to disambiguate. */
  fichaLabel: string;
  /** An example of the real thing, never a shape hint. */
  placeholder: string;
  /** What it is FOR, and the trap of the paper when there is one. */
  help: string;
  /** What this field DOES, next to the price symbol that merely quotes (ADR 0011). */
  provenance: string;
}

const COPY: Record<SecurityIdKind, SecurityIdFieldCopy> = {
  dgs: {
    searchLabel: "Buscar plan",
    altaLabel: `${SECURITY_ID_KIND_LABEL.dgs} del plan`,
    fichaLabel: SECURITY_ID_KIND_LABEL.dgs,
    placeholder: "N5394",
    help:
      "Es el código con el que la Dirección General de Seguros identifica tu plan, y " +
      "está impreso en tu extracto. Con él, tu plan y el de otra persona son el mismo " +
      "producto. Ojo: el papel imprime también el código del fondo (F####); ese no es.",
    provenance: "identifica el producto",
  },
  isin: {
    searchLabel: null,
    altaLabel: SECURITY_ID_KIND_LABEL.isin,
    fichaLabel: SECURITY_ID_KIND_LABEL.isin,
    placeholder: "IE00B52MJY50",
    help:
      "El código que identifica el producto. Con él, un extracto de tu bróker reconoce " +
      "esta posición y hereda su ficha de exposición; sin él, no. Si eliges un " +
      "resultado de la búsqueda, lo rellenamos nosotros.",
    provenance: "identifica el producto",
  },
};

export function securityIdFieldCopy(kind: SecurityIdKind): SecurityIdFieldCopy {
  return COPY[kind];
}

/**
 * La procedencia del símbolo de precio, al lado del identificador (ADR 0011): uno
 * identifica el producto, el otro solo lo cotiza. En un plan el símbolo además es
 * DERIVADO —lo sembró el código DGS en el alta (#1746)—, y decirlo es lo que evita
 * que los dos campos se lean como el mismo dato escrito dos veces.
 */
export function priceSymbolProvenance({
  kind,
  providerLabel,
}: {
  kind: SecurityIdKind;
  providerLabel: string;
}): string {
  return kind === "dgs"
    ? `${providerLabel} — sembrado del código DGS en el alta. Cotiza el plan; no lo identifica.`
    : `${providerLabel} — cotiza esta posición; quien la identifica es su ${SECURITY_ID_KIND_LABEL_INLINE.isin}.`;
}

export interface SecurityIdFieldState {
  /** What the input shows. */
  value: string;
  /**
   * Set when what is STORED is not of the kind this field asks for: a plan whose
   * identifier was written as an ISIN (the state #1745 could see and not warn
   * about), or a value the import preserved with no kind at all (#1743).
   */
  mismatch?: string;
}

/**
 * What the ficha's identifier field shows, and what it must say out loud.
 *
 * A stored value of ANOTHER kind is never silently offered as this field's own:
 * that is how a plan came to carry an ISIN in the first place. It is quoted back in
 * a line the user can act on — the value is real data somebody typed once, and the
 * repair is a reading, not a deletion.
 */
export function securityIdFieldState({
  kind,
  stored,
  typed,
}: {
  kind: SecurityIdKind;
  stored: StoredSecurityId | null | undefined;
  /** What a rejected save brought back — always wins, or the user retypes it. */
  typed: string | undefined;
}): SecurityIdFieldState {
  if (typed !== undefined) return { value: typed };
  if (!stored) return { value: "" };
  if (stored.kind === kind) return { value: stored.value };

  return {
    value: "",
    mismatch:
      `El identificador guardado («${stored.value}») no es un ` +
      `${SECURITY_ID_KIND_LABEL_INLINE[kind]}, así que no identifica este producto: ` +
      "ni un extracto casa por él ni hereda su ficha de exposición. Teclea el " +
      `${SECURITY_ID_KIND_LABEL_INLINE[kind]} para reemplazarlo.`,
  };
}
