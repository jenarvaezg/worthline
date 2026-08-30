/**
 * The trust boundary between a tool answer and a proposal card (#1609).
 *
 * Three questions per kind, and the same three for all of them: does a real payload
 * become the domain value, does a payload from before a contract field existed lose
 * the card instead of crashing on it, and does a field nobody declared stay out of
 * what the card renders.
 */

import { proposalCardFrom } from "@web/asistente/proposal-card-presence";
import { describe, expect, it } from "vitest";
import { parseBalanceHistoryProposal } from "./balance-history";
import { parseCorrectionProposal } from "./correction";
import { parseEarlyRepaymentProposal } from "./early-repayment";
import {
  balanceHistoryOutput,
  correctionOutput,
  earlyRepaymentOutput,
  fundPreviewRow,
  holdingCreationOutput,
  holdingRemovalOutput,
  mixedDocumentOutput,
  operationOutput,
  propertyAcquisitionOutput,
  propertyValuationOutput,
  reconcileOutput,
  reconcileRow,
  reconstructionOutput,
  statementImportOutput,
  transferOutput,
} from "./fixtures";
import { parseHoldingCreationProposal } from "./holding-creation";
import { parseHoldingTrashProposal } from "./holding-trash";
import { parseMixedDocumentProposal } from "./mixed-document";
import { parseOperationProposal } from "./operation";
import { parsePropertyAcquisitionProposal } from "./property-acquisition";
import { parsePropertyValuationProposal } from "./property-valuation";
import { parseReconcileProposal } from "./reconcile";
import { parseStatementImportProposal } from "./statement-import";
import { parseTransferProposal } from "./transfer";

type Payload = Record<string, unknown>;

/**
 * Every lane, with the tool that answers it, one real payload, and the field a payload
 * from an older deploy would be missing.
 */
const LANES: Array<{
  lane: string;
  tool: string;
  parse: (raw: unknown) => unknown;
  output: (overrides?: Payload) => Payload;
  /** Dropping this field must lose the card — it is one the surface renders. */
  stale: string;
}> = [
  {
    lane: "correction · solo desde hoy",
    output: correctionOutput,
    parse: parseCorrectionProposal,
    stale: "guarantee",
    tool: "propose_correction",
  },
  {
    lane: "correction · reconstruir",
    output: reconstructionOutput,
    parse: parseCorrectionProposal,
    stale: "reconciliation",
    tool: "propose_reconstruction",
  },
  {
    lane: "balance history",
    output: balanceHistoryOutput,
    parse: parseBalanceHistoryProposal,
    stale: "reconciliation",
    tool: "propose_balance_history_import",
  },
  {
    lane: "early repayment",
    output: earlyRepaymentOutput,
    parse: parseEarlyRepaymentProposal,
    stale: "repayment",
    tool: "propose_early_repayment",
  },
  {
    lane: "holding creation",
    output: holdingCreationOutput,
    parse: parseHoldingCreationProposal,
    stale: "impact",
    tool: "propose_holding",
  },
  {
    lane: "holding removal",
    output: holdingRemovalOutput,
    parse: (raw) => parseHoldingTrashProposal(raw, "holding_removal"),
    stale: "lines",
    tool: "propose_holding_removal",
  },
  {
    lane: "operation",
    output: operationOutput,
    parse: parseOperationProposal,
    stale: "position",
    tool: "propose_operation",
  },
  {
    lane: "transfer",
    output: transferOutput,
    parse: parseTransferProposal,
    stale: "origin",
    tool: "propose_transfer",
  },
  {
    lane: "property valuation",
    output: propertyValuationOutput,
    parse: parsePropertyValuationProposal,
    stale: "anchor",
    tool: "propose_property_valuation_anchor",
  },
  {
    lane: "property acquisition",
    output: propertyAcquisitionOutput,
    parse: parsePropertyAcquisitionProposal,
    stale: "points",
    tool: "propose_property_acquisition",
  },
  {
    lane: "reconcile",
    output: reconcileOutput,
    parse: parseReconcileProposal,
    stale: "rows",
    tool: "propose_reconcile",
  },
  {
    lane: "statement import",
    output: statementImportOutput,
    parse: parseStatementImportProposal,
    stale: "funds",
    tool: "propose_statement_import",
  },
  {
    lane: "mixed document",
    output: mixedDocumentOutput,
    parse: parseMixedDocumentProposal,
    stale: "sections",
    tool: "propose_mixed_document_import",
  },
];

describe.each(LANES)("$lane", ({ output, parse, stale, tool }) => {
  it("parses the payload its tool really answers with", () => {
    expect(parse(output())).not.toBeNull();
  });

  it("paints a card through the lane's registered parser", () => {
    expect(proposalCardFrom(tool, output())).not.toBeNull();
  });

  it(`loses the card when a payload carries no \`${stale}\``, () => {
    expect(parse(output({ [stale]: undefined }))).toBeNull();
  });

  it("keeps parsing when the payload carries a field nobody declared", () => {
    const parsed = parse(output({ inventado: "de más" }));
    expect(parsed).not.toBeNull();
    // The kind closes the type: what the card renders is what the contract names.
    expect(parsed).not.toHaveProperty("inventado");
  });

  it("refuses a payload of another kind", () => {
    expect(parse(output({ proposalType: "otra_cosa" }))).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(parse(null)).toBeNull();
    expect(parse([output()])).toBeNull();
    expect(parse("propuesta")).toBeNull();
  });
});

describe("parseCorrectionProposal (#1051/#1053)", () => {
  it("refuses a half verdict the card would crash on (#1422)", () => {
    // La tarjeta desreferencia `reconciliation.anchor.stale` al renderizar: un
    // veredicto a medias no es media garantía, es una excepción.
    const half = reconstructionOutput({
      reconciliation: { matches: true, status: "exact" },
    });
    expect(parseCorrectionProposal(half)).toBeNull();
  });

  it("refuses a reconciled guarantee with no figures to print", () => {
    expect(
      parseCorrectionProposal(
        reconstructionOutput({ guarantee: { state: "reconciled" } }),
      ),
    ).toBeNull();
  });

  it("refuses a reconstruct payload missing the anchor", () => {
    expect(
      parseCorrectionProposal(reconstructionOutput({ anchorMinor: undefined })),
    ).toBeNull();
  });

  it("refuses an unknown mode", () => {
    expect(parseCorrectionProposal(correctionOutput({ mode: "otra-cosa" }))).toBeNull();
  });

  it("keeps the card when a payload predates the membership preflight (#1438)", () => {
    // The card degrades to «no warning» on its own; losing the whole card would be
    // the harsher answer, and the confirm gate reads the same absent value.
    const parsed = parseCorrectionProposal(
      reconstructionOutput({ snapshotMembership: undefined }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("snapshotMembership");
  });

  it("refuses a membership that states neither total nor missing", () => {
    expect(
      parseCorrectionProposal(
        reconstructionOutput({ snapshotMembership: { total: 12 } }),
      ),
    ).toBeNull();
  });
});

describe("parseReconcileProposal (#1108)", () => {
  it("refuses a row with no candidates, which the card edits against", () => {
    const rows = [reconcileRow({ match: { decision: "update", rowId: "row-0" } })];
    expect(parseReconcileProposal(reconcileOutput({ rows }))).toBeNull();
  });

  it("refuses a row whose movements are not the evidence the header sums (#1373)", () => {
    const rows = [reconcileRow({ movements: [{ date: "2026-01-05", kind: "buy" }] })];
    expect(parseReconcileProposal(reconcileOutput({ rows }))).toBeNull();
  });

  it("refuses an instrument outside the catalog", () => {
    const rows = [reconcileRow({ instrument: "criptomoneda" })];
    expect(parseReconcileProposal(reconcileOutput({ rows }))).toBeNull();
  });

  it("keeps a row whose instrument was unrecognized (a null, not a guess)", () => {
    const rows = [reconcileRow({ instrument: null })];
    expect(parseReconcileProposal(reconcileOutput({ rows }))).not.toBeNull();
  });

  it("accepts a degraded net-worth read as null, never as a fabricated 0 € (ADR 0048)", () => {
    const parsed = parseReconcileProposal(reconcileOutput({ netWorthBeforeMinor: null }));
    expect(parsed).not.toBeNull();
    expect(parsed?.netWorthBeforeMinor).toBeNull();
  });

  it("refuses a net worth that is neither a number nor a null", () => {
    expect(
      parseReconcileProposal(reconcileOutput({ netWorthBeforeMinor: "140.000 €" })),
    ).toBeNull();
  });
});

describe("parseStatementImportProposal (#933)", () => {
  it("refuses a new-bucket row with no ISIN lookup to show", () => {
    const funds = [
      fundPreviewRow({
        ambiguous: undefined,
        assetId: undefined,
        bucket: "new",
        choices: undefined,
        existingName: undefined,
        suggestedName: "Vanguard Global Stock",
        suggestedSymbol: "0P0000KSPA",
        toCreateCount: undefined,
        toDeleteCount: undefined,
        toOverwriteCount: undefined,
      }),
    ];
    expect(parseStatementImportProposal(statementImportOutput({ funds }))).toBeNull();
  });

  it("parses a new-bucket row that carries its lookup", () => {
    const funds = [
      fundPreviewRow({
        ambiguous: undefined,
        assetId: undefined,
        bucket: "new",
        choices: undefined,
        existingName: undefined,
        lookup: { status: "not_found" },
        suggestedName: "Vanguard Global Stock",
        suggestedSymbol: "0P0000KSPA",
        toCreateCount: undefined,
        toDeleteCount: undefined,
        toOverwriteCount: undefined,
      }),
    ];
    expect(parseStatementImportProposal(statementImportOutput({ funds }))).not.toBeNull();
  });

  it("refuses a row whose position impact has no flags array", () => {
    const funds = [
      fundPreviewRow({
        positionImpact: {
          afterUnits: "3,2",
          afterValueMinor: 1_200_00,
          beforeUnits: "0",
          beforeValueMinor: 0,
        },
      }),
    ];
    expect(parseStatementImportProposal(statementImportOutput({ funds }))).toBeNull();
  });
});

describe("parseHoldingTrashProposal (#1106)", () => {
  it("will not paint a removal payload as a restoration card", () => {
    expect(
      parseHoldingTrashProposal(holdingRemovalOutput(), "holding_restoration"),
    ).toBeNull();
  });

  it("refuses a line that states no signed contribution", () => {
    const lines = [{ holdingId: "wl_hld_1", kind: "asset", name: "Fondo" }];
    expect(
      parseHoldingTrashProposal(holdingRemovalOutput({ lines }), "holding_removal"),
    ).toBeNull();
  });
});

describe("parseHoldingCreationProposal (#1105)", () => {
  it("refuses a family outside the four the alta knows", () => {
    expect(
      parseHoldingCreationProposal(holdingCreationOutput({ family: "cripto" })),
    ).toBeNull();
  });

  it("keeps a degraded impact read (ADR 0048) with only the delta known", () => {
    const parsed = parseHoldingCreationProposal(
      holdingCreationOutput({
        impact: { afterMinor: null, beforeMinor: null, deltaMinor: 1_200_00 },
      }),
    );
    expect(parsed?.impact.beforeMinor).toBeNull();
    expect(parsed?.impact.deltaMinor).toBe(1_200_00);
  });

  it("refuses an opening breakdown with no unit price to confirm (#1315)", () => {
    const holding = holdingCreationOutput().holding as Payload;
    expect(
      parseHoldingCreationProposal(
        holdingCreationOutput({ holding: { ...holding, opening: { units: "3,2" } } }),
      ),
    ).toBeNull();
  });
});

describe("parseOperationProposal (#1374)", () => {
  it("refuses a kind the document cannot claim", () => {
    expect(parseOperationProposal(operationOutput({ kind: "traspaso" }))).toBeNull();
  });

  it("refuses notes that are not all strings", () => {
    expect(parseOperationProposal(operationOutput({ notes: ["ok", 3] }))).toBeNull();
  });
});

describe("parseEarlyRepaymentProposal (#1245)", () => {
  it("keeps a null reconciliation — the capture showed no cuota to compare", () => {
    const parsed = parseEarlyRepaymentProposal(earlyRepaymentOutput());
    expect(parsed?.reconciliation).toBeNull();
  });

  it("refuses a half reconciliation the card would print blanks from", () => {
    expect(
      parseEarlyRepaymentProposal(
        earlyRepaymentOutput({ reconciliation: { matches: true } }),
      ),
    ).toBeNull();
  });

  it("refuses a mode outside the two reshapings", () => {
    const repayment = earlyRepaymentOutput().repayment as Payload;
    expect(
      parseEarlyRepaymentProposal(
        earlyRepaymentOutput({ repayment: { ...repayment, mode: "cancelar" } }),
      ),
    ).toBeNull();
  });
});

describe("parseMixedDocumentProposal (ADR 0059)", () => {
  it("refuses a section of a kind no projector handles", () => {
    const sections = [{ assetKey: "x", kind: "seguro", preview: { trust: {} } }];
    expect(parseMixedDocumentProposal(mixedDocumentOutput({ sections }))).toBeNull();
  });

  it("refuses a debt segment with no reconciliation figures", () => {
    const section = (mixedDocumentOutput().sections as Payload[])[0] as Payload;
    const preview = section["preview"] as Payload;
    const sections = [
      { ...section, preview: { ...preview, reconciliation: { matches: true } } },
    ];
    expect(parseMixedDocumentProposal(mixedDocumentOutput({ sections }))).toBeNull();
  });
});
