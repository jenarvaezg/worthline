/**
 * The rows of MyInvestor's first start and what ticking them adds up to (#1880), and
 * what each product with a manual twin is set to do (#1881). Client-safe on purpose:
 * the fold's island recomputes the panel «Así queda tu patrimonio» as boxes are
 * ticked and twins are decided, so this module imports no adapter and no store, only
 * types. The rows themselves are built server-side by `myinvestor-first-start.ts`.
 */
import type { DecimalString } from "@worthline/domain";
import type { MyInvestorCareo } from "./myinvestor-careo";
import type {
  MyInvestorDiscoveredAccount,
  MyInvestorProductKind,
} from "./myinvestor-discovery";

/** Where a product lands in the patrimonio. */
export type MyInvestorRung = "liquid" | "invested" | "retirement";

export const MYINVESTOR_RUNG_LABEL: Record<MyInvestorRung, string> = {
  invested: "Invertido",
  liquid: "Líquido",
  retirement: "Jubilación",
};

export const MYINVESTOR_KIND_LABEL: Record<MyInvestorProductKind, string> = {
  cash: "Efectivo",
  etf: "ETF",
  fund: "Fondo",
  managed: "Cartera gestionada",
  plan: "Plan de pensiones",
  stock: "Acción",
};

/** Why a product cannot be included in this slice; each one is another slice's. */
export type MyInvestorInclusionBlock =
  /** An operation in another currency: the holding would sum two currencies (#1401). */
  { readonly reason: "currency" };

/** A fund of a robo-advisor's managed portfolio, under its row (#1883). */
export interface MyInvestorPortfolioMember {
  readonly key: string;
  readonly name: string;
  readonly identifier: string | null;
  readonly units: DecimalString | null;
  /** Its cost from the same fold the batch writes, until worthline prices it. */
  readonly valueMinor: number;
  readonly operations: number;
  /** No participaciones today but a history: the manager sold it whole. */
  readonly soldByManager: boolean;
}

/** The robo-advisor's own cash account: the portfolio's cash sibling (ADR 0085). */
export interface MyInvestorPortfolioCash {
  readonly key: string;
  readonly name: string;
  readonly identifier: string | null;
  readonly valueMinor: number;
}

/** What a managed portfolio row is made of (#1883): its funds, its cash, its witness. */
export interface MyInvestorPortfolioBlock {
  readonly members: readonly MyInvestorPortfolioMember[];
  readonly cash: MyInvestorPortfolioCash | null;
  /** The funds' value the manager declares, cash left out (#1550); null when none. */
  readonly declaredMinor: number | null;
  /**
   * The portfolio a block already linked lives in, when its manager bought funds
   * since: the row then offers only those, and they join it. Null otherwise.
   */
  readonly joins: { readonly portfolioId: string; readonly name: string } | null;
}

/**
 * One fund of the robo-advisor in the careo of a portfolio kept by hand (#1883): the
 * manual member it replaces, with the careo of #1881, or none when it enters new.
 */
export interface MyInvestorPortfolioMemberCareo {
  readonly productKey: string;
  readonly name: string;
  /** The manual member it replaces; null when the fund enters the portfolio new. */
  readonly assetId: string | null;
  readonly assetName: string | null;
  readonly careo: MyInvestorCareo | null;
  /** What the fund adds when it enters new: its value; 0 when it replaces one. */
  readonly enteringMinor: number;
}

/** A managed portfolio kept by hand that the robo-advisor's block may be (#1883). */
export interface MyInvestorPortfolioCandidate {
  readonly portfolioId: string;
  readonly name: string;
  /** The ficha of the portfolio, where a member is taken out; null without one. */
  readonly href: string | null;
  readonly members: readonly MyInvestorPortfolioMemberCareo[];
  /**
   * MyInvestor's cash account against the manual cash sibling it replaces, before
   * and after; `assetId` null when the portfolio has no sibling and it enters new.
   * Null when MyInvestor has no cash account for the block.
   */
  readonly cash: {
    readonly assetId: string | null;
    readonly name: string;
    readonly beforeMinor: number;
    readonly afterMinor: number;
  } | null;
  /**
   * The manual members MyInvestor does not have in this account. Any one blocks the
   * link: «Crear aparte» would count them twice, linking would orphan them (#1883).
   */
  readonly blockers: readonly string[];
  /**
   * The holdings outside the portfolio holding the other half of a member's
   * traspaso: linking would leave that half behind (#1393), so they block too.
   */
  readonly strandedTransfers: readonly string[];
  /** What linking adds to the patrimonio: differences, plus what enters new. */
  readonly valueDeltaMinor: number;
}

/** Whether nothing stands in the way of linking the block with this portfolio. */
export function isPortfolioLinkable(candidate: MyInvestorPortfolioCandidate): boolean {
  return candidate.blockers.length === 0 && candidate.strandedTransfers.length === 0;
}

function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `«${name}»`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} y ${quoted.at(-1)}`;
}

/**
 * Why the block cannot be linked with this portfolio, and what to do about it
 * (#1883): the fold shows it beside the disabled «Enlazar», and the batch refuses
 * with the same words. Empty when it can be linked.
 */
export function myInvestorPortfolioBlockedReason(
  candidate: MyInvestorPortfolioCandidate,
): string {
  if (candidate.blockers.length > 0) {
    const many = candidate.blockers.length > 1;
    return `No se puede enlazar: ${quotedList(candidate.blockers)} ${
      many ? "están" : "está"
    } en tu cartera y MyInvestor no ${many ? "los" : "lo"} tiene en esta cuenta. ${
      many ? "Sácalos" : "Sácalo"
    } de la cartera o ${many ? "envíalos" : "envíalo"} a la papelera, y vuelve aquí.`;
  }
  if (candidate.strandedTransfers.length > 0) {
    return `No se puede enlazar: un fondo de tu cartera tiene un traspaso con ${quotedList(
      candidate.strandedTransfers,
    )}, fuera de la cartera. Deshaz el traspaso antes, y vuelve aquí.`;
  }
  return "";
}

/** The manual portfolios a robo-advisor's block may be, and its opening choice. */
export interface MyInvestorPortfolioTwin {
  readonly candidates: readonly MyInvestorPortfolioCandidate[];
  /** «Enlazar» for the one candidate nothing blocks; «No incluir» otherwise. */
  readonly defaultChoice: MyInvestorTwinChoice;
}

/** A live manual holding a product could be (#1881), with its careo. */
export interface MyInvestorTwinCandidate {
  readonly assetId: string;
  readonly name: string;
  readonly careo: MyInvestorCareo;
  /**
   * The holdings holding the other half of one of its traspasos: linking it alone
   * would leave that half behind, so they link together or not at all (#1393).
   */
  readonly pairedWith: readonly { readonly assetId: string; readonly name: string }[];
}

/**
 * What to do with a product that has a manual twin, as the form posts it:
 * `link:<assetId>` (MyInvestor replaces that holding's operations), `separate`
 * (created apart, counting twice if it is the same) or `skip` (left out).
 */
export type MyInvestorTwinChoice = `link:${string}` | "separate" | "skip";

/** A product that a live manual holding already is, or may be (#1881). */
export interface MyInvestorTwin {
  /**
   * `identifier`: the holding carries the same ISIN or DGS code — the strong match.
   * `name`: it carries none and only its name is alike — a suggestion, never ticked.
   */
  readonly reason: "identifier" | "name";
  readonly scheme: "isin" | "dgs";
  readonly candidates: readonly MyInvestorTwinCandidate[];
  /** «Enlazar» for the one holding with the same identifier; «No incluir» otherwise. */
  readonly defaultChoice: MyInvestorTwinChoice;
}

export function myInvestorLinkChoice(assetId: string): MyInvestorTwinChoice {
  return `link:${assetId}`;
}

/** The holding a choice links to, or null when it does not link. */
export function linkedAssetOf(choice: MyInvestorTwinChoice): string | null {
  return choice.startsWith("link:") ? choice.slice("link:".length) : null;
}

/** A posted value read back as a choice, or null when it is none. */
export function parseMyInvestorTwinChoice(value: string): MyInvestorTwinChoice | null {
  if (value === "separate" || value === "skip") return value;
  if (value.startsWith("link:") && value.length > "link:".length) {
    return value as MyInvestorTwinChoice;
  }
  return null;
}

export interface MyInvestorProductRow {
  readonly key: string;
  readonly accountKey: string;
  readonly name: string;
  readonly kind: MyInvestorProductKind;
  readonly identifier: string | null;
  readonly units: DecimalString | null;
  /** What the holding is worth in worthline the day it is created: its cost until priced. */
  readonly valueMinor: number;
  readonly rung: MyInvestorRung;
  readonly operations: number;
  /** The first operation's day, `YYYY-MM-DD`; null for cash and a managed portfolio. */
  readonly since: string | null;
  /** Held for orders in progress, already inside the balance (P4); null when none. */
  readonly withheldMinor: number | null;
  readonly otherHolder: boolean;
  /** It came in from another institution: the inherited cost is asked later (#1882). */
  readonly inheritedCostPending: boolean;
  readonly members: readonly string[];
  readonly block: MyInvestorInclusionBlock | null;
  /** A live manual holding is, or may be, this product (#1881); null when none. */
  readonly twin: MyInvestorTwin | null;
  /** A managed portfolio's funds, cash and witness (#1883); null for the rest. */
  readonly portfolio: MyInvestorPortfolioBlock | null;
  /** The portfolios kept by hand this block may be (#1883); null when none. */
  readonly portfolioTwin: MyInvestorPortfolioTwin | null;
  /** Already a linked holding. */
  readonly linked: boolean;
  /** Ticked when the fold opens: what is the user's and holds something today. */
  readonly selectedByDefault: boolean;
}

export interface MyInvestorAccountGroup {
  readonly account: MyInvestorDiscoveredAccount;
  readonly products: readonly MyInvestorProductRow[];
}

export interface MyInvestorFirstStartView {
  readonly readOn: string;
  /** The user's own accounts, in the bank's order. */
  readonly own: readonly MyInvestorAccountGroup[];
  /** Someone else's, at the end, unticked (#1869 P3). */
  readonly others: readonly MyInvestorAccountGroup[];
  readonly rows: readonly MyInvestorProductRow[];
}

/** Whether a row can be ticked: not linked yet, and not another slice's. */
export function isIncludable(row: MyInvestorProductRow): boolean {
  return (
    !row.linked && row.block === null && row.twin === null && row.portfolioTwin === null
  );
}

/** Whether a row is decided by its twin's three choices instead of a box. */
export function isTwinDecision(row: MyInvestorProductRow): boolean {
  return (
    !row.linked && row.block === null && (row.twin !== null || row.portfolioTwin !== null)
  );
}

/** The portfolio kept by hand a choice links the block to, or null (#1883). */
export function portfolioOfChoice(
  row: MyInvestorProductRow,
  choice: MyInvestorTwinChoice,
): MyInvestorPortfolioCandidate | null {
  const portfolioId = linkedAssetOf(choice);
  if (portfolioId === null || row.portfolioTwin === null) return null;
  return (
    row.portfolioTwin.candidates.find(
      (candidate) => candidate.portfolioId === portfolioId,
    ) ?? null
  );
}

/** The careo of the holding a choice links to, or null when it does not link. */
export function careoOfChoice(
  row: MyInvestorProductRow,
  choice: MyInvestorTwinChoice,
): MyInvestorCareo | null {
  const assetId = linkedAssetOf(choice);
  if (assetId === null || row.twin === null) return null;
  return (
    row.twin.candidates.find((candidate) => candidate.assetId === assetId)?.careo ?? null
  );
}

/** Each twin's choice when the fold opens. */
export function defaultMyInvestorTwinChoices(
  rows: readonly MyInvestorProductRow[],
): ReadonlyMap<string, MyInvestorTwinChoice> {
  return new Map(
    rows.flatMap((row) => {
      if (!isTwinDecision(row)) return [];
      const twin = row.twin ?? row.portfolioTwin;
      return twin ? [[row.key, twin.defaultChoice] as const] : [];
    }),
  );
}

/** Decide one twin. Pure: a new map, the old one untouched. */
export function setMyInvestorTwinChoice(
  choices: ReadonlyMap<string, MyInvestorTwinChoice>,
  key: string,
  choice: MyInvestorTwinChoice,
): ReadonlyMap<string, MyInvestorTwinChoice> {
  return new Map(choices).set(key, choice);
}

export interface MyInvestorSelectionSummary {
  /** Holdings created: the ticked products and the twins created apart. */
  readonly count: number;
  /** Manual holdings that become MyInvestor's (#1881). */
  readonly linked: number;
  readonly operations: number;
  /** What it adds to the patrimonio: the new ones whole, the linked by difference. */
  readonly valueMinor: number;
  /** What the new holdings add, by rung. */
  readonly byRung: Readonly<Record<MyInvestorRung, number>>;
  /** What the linked holdings add: the difference with what was kept by hand. */
  readonly linkedDeltaMinor: number;
  /** Entries whose inherited cost will be asked (#1882). */
  readonly pendingCost: number;
  /** Contribution plans that close today because their holding is linked. */
  readonly plansClosing: number;
}

/**
 * What including the ticked rows and deciding the twins adds to the patrimonio.
 * Pure; the panel's figures. A linked holding adds only the difference between
 * MyInvestor's ledger and the manual one, never its whole value (#1881).
 */
export function summarizeMyInvestorSelection(
  rows: readonly MyInvestorProductRow[],
  selected: ReadonlySet<string>,
  choices: ReadonlyMap<string, MyInvestorTwinChoice> = new Map(),
): MyInvestorSelectionSummary {
  const created = rows.filter(
    (row) =>
      (selected.has(row.key) && isIncludable(row)) ||
      (isTwinDecision(row) && choices.get(row.key) === "separate"),
  );
  // A link is one holding's careo (#1881) or a whole portfolio's (#1883): one each.
  const linked = rows.flatMap((row) => {
    if (!isTwinDecision(row)) return [];
    const choice = choices.get(row.key) ?? "skip";
    const careo = careoOfChoice(row, choice);
    if (careo) return [{ careos: [careo], deltaMinor: careo.valueDeltaMinor, row }];
    const portfolio = portfolioOfChoice(row, choice);
    if (!portfolio || !isPortfolioLinkable(portfolio)) return [];
    return [
      {
        careos: portfolio.members.flatMap((member) =>
          member.careo ? [member.careo] : [],
        ),
        deltaMinor: portfolio.valueDeltaMinor,
        row,
      },
    ];
  });
  const byRung: Record<MyInvestorRung, number> = {
    invested: 0,
    liquid: 0,
    retirement: 0,
  };
  for (const row of created) {
    // A robo-advisor's cash is a current account: Líquido, as the patrimonio files
    // it; its funds are Invertido (#1883).
    const cashMinor = row.portfolio?.cash?.valueMinor ?? 0;
    byRung[row.rung] += row.valueMinor - cashMinor;
    byRung.liquid += cashMinor;
  }
  const linkedDeltaMinor = linked.reduce((sum, link) => sum + link.deltaMinor, 0);
  return {
    byRung,
    count: created.length,
    linked: linked.length,
    linkedDeltaMinor,
    operations:
      created.reduce((sum, row) => sum + row.operations, 0) +
      linked.reduce((sum, { row }) => sum + row.operations, 0),
    pendingCost: [...created, ...linked.map(({ row }) => row)].filter(
      (row) => row.inheritedCostPending,
    ).length,
    plansClosing: linked
      .flatMap((link) => link.careos)
      .filter((careo) => careo.plan !== null && careo.plan.lines.length > 0).length,
    valueMinor: created.reduce((sum, row) => sum + row.valueMinor, 0) + linkedDeltaMinor,
  };
}

/** Tick or untick one product. Pure: a new set, the old one untouched. */
export function toggleMyInvestorSelection(
  selected: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Tick or untick every product of a group at once, from its group box. */
export function setMyInvestorSelection(
  selected: ReadonlySet<string>,
  keys: readonly string[],
  on: boolean,
): ReadonlySet<string> {
  const next = new Set(selected);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/**
 * What a group box shows: all of its includable products ticked, none, or some (the
 * mixed state). A group with nothing includable reads as none.
 */
export function myInvestorGroupState(
  includableKeys: readonly string[],
  selected: ReadonlySet<string>,
): "all" | "none" | "mixed" {
  const on = includableKeys.filter((key) => selected.has(key)).length;
  if (includableKeys.length === 0 || on === 0) return "none";
  return on === includableKeys.length ? "all" : "mixed";
}

/** The name of the radio group that decides a twin, per product. */
export function myInvestorTwinField(productKey: string): string {
  return `twin:${productKey}`;
}

/**
 * The fold's form read back (#1880, #1881): the ticked products, plus the twins —
 * those created apart join the products, those linked become links. Pure: a field
 * it does not know is ignored, never guessed.
 */
export function parseMyInvestorInclusionForm(
  entries: Iterable<[string, FormDataEntryValue]>,
): {
  productKeys: string[];
  links: { productKey: string; assetId: string }[];
} {
  const productKeys: string[] = [];
  const links: { productKey: string; assetId: string }[] = [];
  for (const [name, raw] of entries) {
    const value = String(raw);
    if (name === "productKey") {
      if (value) productKeys.push(value);
      continue;
    }
    if (!name.startsWith("twin:")) continue;
    const productKey = name.slice("twin:".length);
    const choice = parseMyInvestorTwinChoice(value);
    if (!productKey || choice === null) continue;
    const assetId = linkedAssetOf(choice);
    if (assetId !== null) links.push({ assetId, productKey });
    else if (choice === "separate") productKeys.push(productKey);
  }
  return { links, productKeys };
}
