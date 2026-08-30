/**
 * One valid payload per proposal kind — what a `propose_*` tool really answers with.
 *
 * They live beside the parsers, not inside the test file, because they are the only
 * honest description of each contract that a reader can run: a fixture that omits a
 * field the card renders is exactly the lie #1609 removed from the parsers, and it
 * would put it back one layer up.
 */

import type { BalanceReconciliation } from "@web/asistente/balance-reconciliation";
import type { FundPositionImpact } from "@web/patrimonio/importar-extracto/statement-import-preview";

type Payload = Record<string, unknown>;

/** Overriding a key with `undefined` DELETES it — that is how a stale payload is written. */
function build(base: Payload, overrides: Payload): Payload {
  const merged: Payload = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

export const RECONCILIATION: BalanceReconciliation = {
  against: "declared",
  anchor: {
    declaredMinor: 140_000_00,
    driftMinor: 0,
    modelMinor: 140_000_00,
    stale: false,
  },
  deltaMinor: 0,
  expectedMinor: 140_000_00,
  matches: true,
  resultingMinor: 140_000_00,
  status: "exact",
  toleranceMinor: 14_000,
};

const POSITION_IMPACT: FundPositionImpact = {
  afterUnits: "3,200000",
  afterValueMinor: 1_200_00,
  beforeUnits: "0",
  beforeValueMinor: 0,
  flags: [],
};

const NET_WORTH_IMPACT = {
  afterMinor: 141_200_00,
  beforeMinor: 140_000_00,
  deltaMinor: 1_200_00,
};

export function correctionOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      edits: [
        { after: "5.511,96 €", before: "6.000,00 €", label: "Saldo", origin: "user" },
      ],
      folio: "1 propuesta · 1 holding · 1 lote atómico",
      guarantee: { state: "declared" },
      holding: { id: "wl_hld_1", name: "Hipoteca" },
      mode: "solo-desde-hoy",
      proposalType: "correction",
      summary: "Corrección del saldo",
    },
    overrides,
  );
}

export function reconstructionOutput(overrides: Payload = {}): Payload {
  return build(
    correctionOutput({
      anchorMinor: 140_000_00,
      curve: [{ balanceMinor: 140_000_00, date: "2026-07-12" }],
      edits: undefined,
      guarantee: {
        anchorMinor: 140_000_00,
        resultingMinor: 140_000_00,
        state: "reconciled",
      },
      mode: "reconstruir",
      reconciliation: RECONCILIATION,
      series: [{ balanceMinor: 140_000_00, date: "2026-07-12", origin: "assistant" }],
      snapshotMembership: { missing: 0, total: 12 },
    }),
    overrides,
  );
}

export function balanceHistoryOutput(overrides: Payload = {}): Payload {
  return build(
    {
      curve: [{ balanceMinor: 140_000_00, date: "2026-07-12" }],
      draft: { proposalId: "wl_prp_1" },
      liability: { id: "wl_hld_1", name: "Hipoteca" },
      points: [
        {
          balanceMinor: 140_000_00,
          date: "2026-07-12",
          driftMinor: null,
          status: "accepted",
        },
      ],
      proposalType: "balance_history_import",
      reconciliation: RECONCILIATION,
      snapshotMembership: { missing: 0, total: 12 },
    },
    overrides,
  );
}

export function earlyRepaymentOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      folio: "1 propuesta · 1 deuda · 1 hecho fechado",
      holding: { id: "wl_hld_1", name: "Hipoteca" },
      notes: ["La cuota se recalcula desde el mes siguiente."],
      proposalType: "early_repayment",
      reconciliation: null,
      repayment: {
        amount: "10.000,00 €",
        boundaryDate: "2026-09-01",
        date: "2026-08-14",
        dateLabel: "14/08/2026",
        mode: "reduce-term",
        modeLabel: "acortar el plazo (misma cuota, acaba antes)",
      },
      rows: [{ after: "130.000,00 €", before: "140.000,00 €", label: "Saldo" }],
      summary: "Amortización anticipada de 10.000 €",
    },
    overrides,
  );
}

export function holdingCreationOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      duplicate: { confidence: "weak", name: "MSCI World" },
      family: "investment",
      folio: "Propuesta de alta · Por estado actual",
      holding: {
        detail: "1.200,00 €",
        instrumentLabel: "Fondo",
        name: "Vanguard Global Stock",
        opening: { pricePerUnit: "375,00 €", units: "3,200000" },
        providerSymbol: "0P0000KSPA",
      },
      impact: NET_WORTH_IMPACT,
      proposalType: "holding_creation",
    },
    overrides,
  );
}

export function holdingRemovalOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      duplicates: [],
      folio: "Propuesta de baja · A la papelera · reversible",
      impact: NET_WORTH_IMPACT,
      lines: [
        {
          contributionMinor: 1_200_00,
          detail: "1.200,00 €",
          holdingId: "wl_hld_1",
          instrumentLabel: "Fondo",
          kind: "asset",
          name: "Vanguard Global Stock",
          sharedOwnership: false,
        },
      ],
      operation: "remove",
      orphanPairs: [],
      proposalType: "holding_removal",
    },
    overrides,
  );
}

export function holdingRestorationOutput(overrides: Payload = {}): Payload {
  return build(
    holdingRemovalOutput({
      duplicates: [
        {
          confidence: "strong",
          liveName: "Vanguard Global Stock",
          name: "Vanguard Global Stock",
        },
      ],
      folio: "Propuesta de restauración · Desde la papelera",
      operation: "restore",
      proposalType: "holding_restoration",
    }),
    overrides,
  );
}

export function operationOutput(overrides: Payload = {}): Payload {
  return build(
    {
      document: {
        caption: "En el documento",
        fact: "Compra de 3,2 participaciones",
        line: "14/08/2026 · COMPRA",
      },
      draft: { proposalId: "wl_prp_1" },
      folio: "1 propuesta · 1 holding · 1 hecho fechado",
      holding: {
        destination: "Vanguard Global Stock · MyInvestor",
        id: "wl_hld_1",
        name: "Vanguard Global Stock",
      },
      impact: NET_WORTH_IMPACT,
      impactCaption: "Estimación con el último valor liquidativo conocido.",
      kind: "buy",
      notes: [],
      position: { unitsAfter: "3,200000", unitsBefore: "0" },
      proposalType: "investment_operation",
      summary: "Compra de 1.200 €",
    },
    overrides,
  );
}

export function transferOutput(overrides: Payload = {}): Payload {
  return build(
    {
      destination: {
        movementLine: "37,203 part. × 19,87091 € · 739,22 €",
        positionLine: "Entran en «B»: 0 → 37,203 participaciones",
      },
      dictated: "Traspaso del 5 % el 14/08/2026",
      draft: { proposalId: "wl_prp_1" },
      folio: "1 propuesta · 2 holdings · 1 traspaso",
      impact: { afterMinor: 140_000_00, beforeMinor: 140_000_00, deltaMinor: 0 },
      impactCaption: "Un traspaso no cambia el patrimonio.",
      inheritedCost: "Coste de adquisición que viaja: 612,45 €",
      notes: [],
      origin: {
        movementLine: "37,203 part. × 19,87091 € · 739,22 €",
        positionLine: "Salen de «A»: 841,262 → 804,059 participaciones",
      },
      proposalType: "investment_transfer",
      summary: "Traspaso de 739,22 €",
    },
    overrides,
  );
}

export function propertyValuationOutput(overrides: Payload = {}): Payload {
  return build(
    {
      anchor: { valuationDate: "2026-06-30", valueMinor: 240_000_00 },
      curve: [{ date: "2026-06-30", valueMinor: 240_000_00 }],
      draft: { proposalId: "wl_prp_1" },
      property: { id: "wl_hld_1", name: "Piso de Madrid" },
      proposalType: "property_valuation_anchor",
      trust: { requiresReview: true, tier: "unverified" },
    },
    overrides,
  );
}

export function propertyAcquisitionOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      folio: "1 propuesta · 1 inmueble · 1 fecha de adquisición",
      notes: [],
      points: [
        {
          afterMinor: 200_000_00,
          beforeMinor: 240_000_00,
          dateKey: "2019-03-01",
          deltaMinor: -40_000_00,
          role: "acquisition_new",
        },
      ],
      property: { id: "wl_hld_1", name: "Piso de Madrid" },
      proposalType: "property_acquisition",
      rows: [{ after: "01/03/2019", before: "—", label: "Fecha de adquisición" }],
      summary: "Adquisición en marzo de 2019",
    },
    overrides,
  );
}

export function reconcileRow(overrides: Payload = {}): Payload {
  return build(
    {
      currency: "EUR",
      excluded: false,
      fidelity: "movements",
      instrument: "fund",
      match: {
        candidates: [
          {
            confidence: "strong",
            holdingId: "wl_hld_1",
            key: "isin",
            name: "Vanguard Global Stock",
          },
        ],
        confidence: "strong",
        decision: "update",
        key: "isin",
        rowId: "row-0",
        target: "wl_hld_1",
      },
      movements: [
        {
          currency: "EUR",
          date: "2026-01-05",
          kind: "buy",
          signedAmountMinor: 500_00,
          unitPrice: 15.6,
          units: 3.2,
        },
      ],
      movementsDeltaMinor: 500_00,
      name: "Vanguard Global Stock",
      rowId: "row-0",
      uncertain: false,
      valueMinor: 1_200_00,
    },
    overrides,
  );
}

export function reconcileOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      netWorthBeforeMinor: 140_000_00,
      proposalType: "reconcile",
      rows: [reconcileRow()],
    },
    overrides,
  );
}

export function fundPreviewRow(overrides: Payload = {}): Payload {
  return build(
    {
      ambiguous: false,
      amountMinor: 1_200_00,
      assetId: "wl_hld_1",
      bucket: "matched",
      choices: [
        {
          assetId: "wl_hld_1",
          closed: false,
          existingName: "Vanguard Global Stock",
          positionImpact: POSITION_IMPACT,
          toCreateCount: 3,
          toDeleteCount: 0,
          toOverwriteCount: 0,
        },
      ],
      executedCount: 3,
      existingName: "Vanguard Global Stock",
      isin: "IE00B03HCZ61",
      positionImpact: POSITION_IMPACT,
      skippedCount: 0,
      toCreateCount: 3,
      toDeleteCount: 0,
      toOverwriteCount: 0,
    },
    overrides,
  );
}

export function statementImportOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      funds: [fundPreviewRow()],
      proposalType: "statement_import",
    },
    overrides,
  );
}

export function mixedDocumentOutput(overrides: Payload = {}): Payload {
  return build(
    {
      draft: { proposalId: "wl_prp_1" },
      proposalType: "mixed_document_import",
      sections: [
        {
          assetKey: "hipoteca",
          kind: "debt_balance_history",
          preview: {
            curve: [{ balanceMinor: 140_000_00, date: "2026-07-12" }],
            liability: { id: "wl_hld_1", name: "Hipoteca" },
            points: [
              {
                balanceMinor: 140_000_00,
                date: "2026-07-12",
                driftMinor: null,
                status: "accepted",
              },
            ],
            reconciliation: {
              expectedMinor: 140_000_00,
              matches: true,
              resultingMinor: 140_000_00,
            },
            trust: { requiresReview: false, tier: "reconciled" },
          },
        },
      ],
    },
    overrides,
  );
}
