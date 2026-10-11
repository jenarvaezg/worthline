/**
 * The two funds of a traspaso are the ones its paper names (#1800).
 *
 * Until this check the lane accepted any pair of ids the model had read, and in the
 * incident of #1793 the model confused the two funds and declared the destination
 * missing — it lived inside a managed portfolio, worth little, below the cut of the
 * portfolio summary. The operation lane had closed the same hole for its single
 * holding (#1374, #1747); this is that check for BOTH sides, through the same piece
 * ({@link ./security-identity}), plus what only a traspaso needs: telling the model
 * WHICH holding carries the paper's identifier, because a traspaso cannot be redone by
 * picking a different paper.
 *
 * What it decides, per side whose paper prints an identifier:
 *
 * - **The holding has it registered** → that side is the paper's. Nothing else is
 *   asked, even when other holdings carry it too: the model chose one of them.
 * - **It registers another one** → refused, naming both.
 * - **It registers none** → it contradicts nothing (the operation's rule), UNLESS
 *   another holding does carry the paper's identifier: then the model picked by name
 *   and the one the paper means is elsewhere — refused, naming it.
 * - **Nobody carries it, and it is the destination** → the fund is not in the book:
 *   the route is an alta with no opening and that identifier, then the traspaso. The
 *   origin gets no such route — nothing can leave a fund the book does not hold.
 *
 * Who chooses: never the app. A refusal names the holdings that carry the identifier
 * and returns their public ids in `candidateHoldings` — ids worthline's OWN lookup
 * found, which therefore count as read (#1263, see `holding-id-provenance.ts`) — and
 * with several of them the person is asked which one it is.
 *
 * Where it looks: every live investment of the workspace — the same rows the write
 * gate itself accepts — which includes the members of a managed portfolio, since a
 * member is an ordinary holding with a bridge row (ADR 0085).
 */

import { publicIdMap, requirePublicId } from "@web/agent-view/scope-resolution";
import type { InvestmentAssetMeta, WorthlineStore } from "@worthline/db";
import {
  declaredSecurityId,
  SECURITY_ID_KIND_LABEL_INLINE,
  type SecurityId,
} from "@worthline/domain";

import type { ValidatedAttachment } from "./attachment-chat";
import { modelRefusal, type ProposalRefusal, userRefusal } from "./proposal-refusal";
import {
  contradictingSecurityId,
  holdingsRegistering,
  sameSecurityId,
  securityIdLabel,
} from "./security-identity";
import {
  EMPTY_TRANSFER_BOOK,
  securityIdKey,
  type TransferBook,
  transferPaperIds,
} from "./transfer-book";

/** One side of the traspaso as the paper prints it. */
export interface PrintedFund {
  name: string;
  /** The identifier the paper prints for that fund, when it prints one. */
  securityId?: SecurityId;
}

/** A holding worthline found carrying the paper's identifier: its public id and name. */
export interface CandidateHolding {
  id: string;
  label: string;
}

/** A refusal that may name the holdings the paper's identifier points to. */
export type TransferIdentityRefusal = ProposalRefusal & {
  candidateHoldings?: CandidateHolding[];
};

type TransferSide = "origin" | "destination";

interface SideClaim {
  /** The internal asset id the model's public id resolved to. */
  assetId: string;
  printed: PrintedFund;
}

type IdentityStore = Pick<WorthlineStore, "assets"> & {
  agentView: WorthlineStore["agentView"];
};

/**
 * The refusal for the first side whose holding is not the paper's, or null when both
 * are (or the paper prints no identifier to check). The origin is judged first: a
 * swap of the two funds is then answered with the holding the origin really is.
 */
export async function transferIdentityRefusal(
  store: IdentityStore,
  claims: { origin: SideClaim; destination: SideClaim },
): Promise<TransferIdentityRefusal | null> {
  if (!claims.origin.printed.securityId && !claims.destination.printed.securityId) {
    return null;
  }
  const investments = await store.assets.readInvestmentAssetsWithMeta();
  const verdicts = (["origin", "destination"] as const).map((side) =>
    sideVerdict(side, claims[side], investments),
  );
  const failing = verdicts.find((verdict) => verdict !== null);
  if (!failing) return null;

  const publicIds = publicIdMap(await store.agentView.readPublicIds(), "holding");
  return refusalFor(failing, publicIds);
}

/**
 * The confirm's re-check: the holding now registers an identifier that contradicts
 * the paper's — a ficha edit since the card was armed. Only the contradiction: who else
 * carries the identifier is the build's question, asked while the model can still pick.
 */
export function transferIdentityContradiction(
  side: TransferSide,
  printed: SecurityId | undefined,
  holding: Pick<InvestmentAssetMeta, "name" | "securityId">,
): string | null {
  const registered = contradictingSecurityId(printed, holding.securityId);
  if (!printed || !registered) return null;
  return (
    `${pointsAt(side, printed)}, y «${holding.name}» tiene registrado el ` +
    `${securityIdLabel(registered)}: son instrumentos distintos, así que no anoto el ` +
    "traspaso."
  );
}

/** Why one side is not the paper's, with what worthline found instead. */
interface SideVerdict {
  side: TransferSide;
  printed: PrintedFund & { securityId: SecurityId };
  /** The holding the model named, when it is an investment at all. */
  holding: InvestmentAssetMeta | undefined;
  /** The identifier that holding registers instead, if any. */
  registered: SecurityId | null;
  /** The holdings that DO register the paper's identifier. */
  carriers: InvestmentAssetMeta[];
}

function sideVerdict(
  side: TransferSide,
  claim: SideClaim,
  investments: readonly InvestmentAssetMeta[],
): SideVerdict | null {
  const printedId = claim.printed.securityId;
  if (!printedId) return null;
  const holding = investments.find((item) => item.id === claim.assetId);
  const registered = declaredSecurityId(holding?.securityId);
  if (registered && sameSecurityId(registered, printedId)) return null;

  const carriers = holdingsRegistering(printedId, investments);
  // Nothing registered and nobody else carrying it: nothing contradicts the pick (the
  // operation's rule). A side that is not an investment at all is the projection's to
  // refuse — except a destination nobody carries, which is the alta route below.
  const nothingContradicts = !registered && carriers.length === 0;
  if (nothingContradicts && (holding !== undefined || side === "origin")) return null;
  return {
    carriers,
    holding,
    printed: { ...claim.printed, securityId: printedId },
    registered,
    side,
  };
}

function refusalFor(
  verdict: SideVerdict,
  publicIds: Map<string, string>,
): TransferIdentityRefusal {
  const { carriers, holding, printed, registered, side } = verdict;
  const id = printed.securityId;
  const kind = SECURITY_ID_KIND_LABEL_INLINE[id.kind];
  const named = holding ? `«${holding.name}»` : "esa posición";
  const opening =
    `${pointsAt(side, id, printed.name)}, y ${named} ` +
    (registered
      ? `tiene registrado el ${securityIdLabel(registered)}: son instrumentos distintos.`
      : `no tiene ese ${kind} registrado.`);

  if (carriers.length === 0) {
    if (side === "destination") {
      return userRefusal(
        "transfer_destination_not_held",
        `${opening} Ninguna posición de tu patrimonio lleva el ${securityIdLabel(id)}, ` +
          "así que ese fondo aún no está en él: primero se da de alta sin valoración de " +
          `apertura y con su ${kind} —su valor lo traen las participaciones que entran ` +
          "con el traspaso— y después se anota el traspaso.",
      );
    }
    return userRefusal(
      "transfer_identity_mismatch",
      `${opening} Ninguna posición de tu patrimonio lleva el ${securityIdLabel(id)}: si ` +
        "el fondo de origen está registrado sin él, dime cuál es; si no está, no hay de " +
        "dónde sacar las participaciones.",
    );
  }

  const candidateHoldings = carriers.map((carrier) => ({
    id: requirePublicId(publicIds, carrier.id),
    label: carrier.name,
  }));
  // From here on worthline FOUND the holding the paper means, so the model fixes the
  // call by passing it — or by asking which one, with several. That is the model's to
  // do, and the screen has nothing to quote (story 31). Above, nobody carries the
  // identifier: no other id fixes it, and the person is told why.
  if (carriers.length === 1) {
    return {
      ...modelRefusal(
        "transfer_identity_mismatch",
        `${opening} El ${securityIdLabel(id)} lo tiene registrado «${carriers[0]!.name}».`,
      ),
      candidateHoldings,
    };
  }
  return {
    ...modelRefusal(
      "transfer_identity_ambiguous",
      `${opening} El ${securityIdLabel(id)} lo tienen registrado varias posiciones: ` +
        `${carriers.map((carrier) => `«${carrier.name}»`).join(", ")}. Dime cuál es la ` +
        `de ${side === "origin" ? "origen" : "destino"}.`,
    ),
    candidateHoldings,
  };
}

/**
 * Holdings as the model may name them: the public id worthline minted, and the name.
 * Filled ONLY from rows the store returned — never from an id the model passed — which
 * is why these may count as read (#1263, `CANDIDATE_HOLDINGS_FIELD`).
 */
function candidatesOf(
  carriers: readonly InvestmentAssetMeta[],
  publicIds: Map<string, string>,
): CandidateHolding[] {
  return carriers.map((carrier) => ({
    id: requirePublicId(publicIds, carrier.id),
    label: carrier.name,
  }));
}

/**
 * Who carries each identifier a traspaso paper prints, BEFORE the model picks (#1793,
 * decided with Jose): the same search as the refusals above — every live investment of
 * the workspace, managed-portfolio members included — answered for the paper's own
 * identifiers, so the model reads what worthline found next to the paper instead of
 * searching by a printed name (see {@link ./transfer-book}).
 *
 * Paid only when a traspaso paper is in the window: with no identifier to look for, the
 * store is not even opened.
 */
export async function readTransferBook(
  store: IdentityStore,
  attachments: readonly ValidatedAttachment[],
): Promise<TransferBook> {
  const ids = transferPaperIds(attachments);
  if (ids.length === 0) return EMPTY_TRANSFER_BOOK;
  const investments = await store.assets.readInvestmentAssetsWithMeta();
  const publicIds = publicIdMap(await store.agentView.readPublicIds(), "holding");
  return new Map(
    ids.map((id) => [
      securityIdKey(id),
      candidatesOf(holdingsRegistering(id, investments), publicIds),
    ]),
  );
}

/**
 * «El justificante dice que el traspaso sale de «X» (ISIN …)» — or, when the printed
 * name is not at hand (the confirm keeps only the identifier), «… sale del ISIN …».
 */
function pointsAt(side: TransferSide, id: SecurityId, name?: string): string {
  const fund =
    name === undefined
      ? `${side === "origin" ? "del" : "en el"} ${securityIdLabel(id)}`
      : `${side === "origin" ? "de" : "en"} «${name}» (${securityIdLabel(id)})`;
  return `El justificante dice que el traspaso ${side === "origin" ? "sale" : "entra"} ${fund}`;
}
