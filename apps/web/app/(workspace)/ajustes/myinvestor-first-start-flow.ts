/**
 * The first start of MyInvestor as functions over ports (#1880): the store, a client
 * bound to the connection's device, the price-symbol lookup and the clock. The server
 * actions only wire them and choose the terminal; the decisions are in the pure
 * `myinvestor-first-start.ts` and `myinvestor-discovery.ts`.
 *
 * Two steps:
 * 1. **Read the products.** It needs a MyInvestor session. Connecting with the
 *    password remembered, or from a device MyInvestor already knew, leaves one in
 *    hand and the read happens right then. Otherwise — the code of the SMS proved
 *    the device but the password was not kept (ADR 0114 decision 1) — the fold asks
 *    for it once, and the known device needs no SMS.
 * 2. **Include.** No session: it applies what the read found, so including later
 *    what was left out never asks MyInvestor again. The same batch links the
 *    products a manual holding already was (#1881).
 */
import {
  managedPortfolioFichaHref,
  managedPortfolioPublicIdIndex,
} from "@web/holding-route";
import type { WorthlineStore } from "@web/store";
import type {
  FxRateSnapshot,
  InvestmentPriceProvider,
  ManagedPortfolio,
  ManualAsset,
  OwnershipShare,
} from "@worthline/domain";
import type {
  MyInvestorClient,
  MyInvestorCredentials,
  MyInvestorErrorKind,
  MyInvestorReader,
  ResolveFxRateSnapshotOptions,
} from "@worthline/pricing";
import { MyInvestorSyncError } from "@worthline/pricing";
import { MYINVESTOR_LOGIN_ERRORS, MYINVESTOR_NOT_FOUND } from "./myinvestor-copy";
import { hasSavedPassword, readMyInvestorCredentials } from "./myinvestor-credentials";
import {
  type MyInvestorDiscovery,
  parseMyInvestorDiscovery,
  readMyInvestorDiscovery,
  serializeMyInvestorDiscovery,
} from "./myinvestor-discovery";
import { logMyInvestorFailure, type MyInvestorServerLog } from "./myinvestor-failure-log";
import { myInvestorFirstStartView } from "./myinvestor-first-start";
import {
  type MyInvestorLinkChoice,
  type MyInvestorPriceSymbol,
  planMyInvestorInclusion,
} from "./myinvestor-inclusion-plan";
import {
  findMyInvestorPortfolioTwins,
  type MyInvestorManualPortfolio,
} from "./myinvestor-portfolio";
import { resolveMyInvestorRates } from "./myinvestor-rates";
import type { MyInvestorFirstStartView } from "./myinvestor-selection";
import { soldUnpairedOutIds } from "./myinvestor-sync-plan";
import {
  findMyInvestorTwins,
  type MyInvestorManualCash,
  type MyInvestorManualHolding,
  type MyInvestorTwinLedger,
} from "./myinvestor-twins";

const MYINVESTOR_ADAPTER = "myinvestor";

export const MYINVESTOR_READ_FAILED =
  "No hemos podido leer tus productos de MyInvestor. No se ha guardado nada; vuelve a intentarlo en unos minutos.";
export const MYINVESTOR_PASSWORD_NEEDED =
  "Escribe tu contraseña de MyInvestor para leer tus productos. No se guarda.";
export const MYINVESTOR_DEVICE_FORGOTTEN =
  "MyInvestor ya no reconoce este dispositivo. Usa «Volver a entrar» para recibir el SMS: no se desconecta nada.";
export const MYINVESTOR_NOTHING_READ =
  "Aún no hemos leído tus productos de MyInvestor. Léelos antes de elegir qué incluir.";

/** What reading needs of the client. */
export type MyInvestorReadClient = Pick<
  MyInvestorClient,
  "loginWithKnownDevice" | "reader"
>;

export type MyInvestorFirstStartStore = {
  connectedSources: Pick<
    WorthlineStore["connectedSources"],
    "readSource" | "saveDiscovery" | "readDiscovery" | "readLinks"
  >;
  command: Pick<WorthlineStore["command"], "includeConnectedHoldings">;
  workspace: Pick<WorthlineStore["workspace"], "readWorkspace">;
  assets: Pick<WorthlineStore["assets"], "readAssets">;
  operations: Pick<WorthlineStore["operations"], "readHoldingLedgers">;
  contributionPlan: Pick<WorthlineStore["contributionPlan"], "readHoldingPlans">;
  managedPortfolios: Pick<WorthlineStore["managedPortfolios"], "readManagedPortfolios">;
  agentView: Pick<WorthlineStore["agentView"], "readPublicIds">;
};

/** What loading the fold reads: everything but the command and the workspace. */
type MyInvestorFoldStore = Pick<
  MyInvestorFirstStartStore,
  | "connectedSources"
  | "assets"
  | "operations"
  | "contributionPlan"
  | "managedPortfolios"
  | "agentView"
>;

export type MyInvestorFlowResult = { ok: true } | { ok: false; error: string };

/** Look a product's ISIN or DGS code up at worthline's price providers; null if none. */
export type MyInvestorSymbolResolver = (
  code: string,
  instrument: "fund" | "etf" | "stock" | "pension_plan",
) => Promise<MyInvestorPriceSymbol | null>;

function readErrorMessage(kind: MyInvestorErrorKind): string {
  switch (kind) {
    case "password_rejected":
      return MYINVESTOR_LOGIN_ERRORS.password_rejected;
    case "rejected_no_reason":
      return MYINVESTOR_LOGIN_ERRORS.rejected_no_reason;
    case "sms_required":
      return MYINVESTOR_DEVICE_FORGOTTEN;
    default:
      return MYINVESTOR_READ_FAILED;
  }
}

async function readConnection(
  store: Pick<MyInvestorFirstStartStore, "connectedSources">,
  sourceId: string,
) {
  const source = await store.connectedSources.readSource(sourceId);
  if (!source || source.adapter !== MYINVESTOR_ADAPTER) return null;
  const credentials = readMyInvestorCredentials(source.credentialsJson);
  return credentials ? { credentials, source } : null;
}

/**
 * Read everything with a session already in hand and keep it. The read is not a
 * write to the book: a failure keeps nothing and says so.
 */
export async function storeMyInvestorDiscovery(
  deps: {
    store: Pick<MyInvestorFirstStartStore, "connectedSources">;
    now: string;
    today: string;
    log?: MyInvestorServerLog;
  },
  input: { sourceId: string; reader: MyInvestorReader },
): Promise<MyInvestorFlowResult> {
  let discovery: MyInvestorDiscovery;
  try {
    discovery = await readMyInvestorDiscovery(input.reader, deps.today);
  } catch (error) {
    if (error instanceof MyInvestorSyncError) {
      logMyInvestorFailure("reading the products", error.error, deps.log);
      return { error: readErrorMessage(error.error.kind), ok: false };
    }
    throw error;
  }
  const saved = await deps.store.connectedSources.saveDiscovery({
    payloadJson: serializeMyInvestorDiscovery(discovery),
    readAt: deps.now,
    readOn: discovery.readOn,
    sourceId: input.sourceId,
  });
  return saved ? { ok: true } : { error: MYINVESTOR_NOT_FOUND, ok: false };
}

/**
 * «Leer mis productos»: sign in on the device MyInvestor already trusts — with the
 * remembered password, or the one typed now, which is used and dropped — and read.
 */
export async function readMyInvestorProducts(
  deps: {
    store: Pick<MyInvestorFirstStartStore, "connectedSources">;
    clientFor: (deviceId: string) => MyInvestorReadClient;
    now: string;
    today: string;
    log?: MyInvestorServerLog;
  },
  input: { sourceId: string; typed: MyInvestorCredentials | null },
): Promise<MyInvestorFlowResult> {
  const connection = await readConnection(deps.store, input.sourceId);
  if (!connection) return { error: MYINVESTOR_NOT_FOUND, ok: false };
  const { credentials } = connection;
  const login = hasSavedPassword(credentials)
    ? { customerId: credentials.customerId, password: credentials.password }
    : input.typed;
  if (!login) return { error: MYINVESTOR_PASSWORD_NEEDED, ok: false };

  const client = deps.clientFor(credentials.deviceId);
  const tokens = await client.loginWithKnownDevice(login);
  if (!tokens.ok) {
    logMyInvestorFailure("signing in to read the products", tokens.error, deps.log);
    return { error: readErrorMessage(tokens.error.kind), ok: false };
  }
  return storeMyInvestorDiscovery(deps, {
    reader: client.reader(tokens.value),
    sourceId: input.sourceId,
  });
}

/**
 * The live MANUAL investments a product could be (#1881): not linked to any source,
 * and not a member of a managed portfolio — a portfolio kept by hand is linked as a
 * block, member by member (#1883), not one fund at a time here.
 */
function manualHoldings(
  portfolios: readonly ManagedPortfolio[],
  assets: readonly ManualAsset[],
): MyInvestorManualHolding[] {
  const members = new Set(portfolios.flatMap((portfolio) => portfolio.holdingIds));
  return assets.flatMap((asset) =>
    asset.type === "investment" &&
    asset.connectedSourceId == null &&
    !members.has(asset.id)
      ? [{ code: asset.securityId?.value || null, id: asset.id, name: asset.name }]
      : [],
  );
}

/**
 * The live MANUAL cash accounts MyInvestor's cash may be: not linked to any source,
 * and not a portfolio's cash sibling, which is linked with its block (#1883).
 */
function manualCashAccounts(
  portfolios: readonly ManagedPortfolio[],
  assets: readonly ManualAsset[],
): MyInvestorManualCash[] {
  const members = new Set(portfolios.flatMap((portfolio) => portfolio.holdingIds));
  return assets.flatMap((asset) =>
    asset.type === "cash" && asset.connectedSourceId == null && !members.has(asset.id)
      ? [{ id: asset.id, name: asset.name, valueMinor: asset.currentValue.amountMinor }]
      : [],
  );
}

/**
 * The managed portfolios kept by hand (#1883): none of their live members is a
 * source's. Each with its live members as the block's careo reads them, and its
 * ficha, where a member MyInvestor lacks is taken out.
 */
function manualPortfolios(
  portfolios: readonly ManagedPortfolio[],
  assets: readonly ManualAsset[],
  fichaOf: (portfolioId: string) => string | null,
): MyInvestorManualPortfolio[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return portfolios.flatMap((portfolio) => {
    const live = portfolio.holdingIds.flatMap((id) => byId.get(id) ?? []);
    if (live.some((asset) => asset.connectedSourceId != null)) return [];
    return [
      {
        href: fichaOf(portfolio.id),
        id: portfolio.id,
        members: live.map((asset) => ({
          code: asset.securityId?.value || null,
          id: asset.id,
          name: asset.name,
          type: asset.type,
          valueMinor: asset.currentValue.amountMinor,
        })),
        name: portfolio.name,
      },
    ];
  });
}

/**
 * What each careo needs of the candidates — ledgers, the prices their valuation
 * reads, their plans and their traspasos' other halves — in a fixed number of
 * reads, whatever the number of candidates (ADR 0030).
 */
async function twinLedgers(
  store: Pick<MyInvestorFoldStore, "operations" | "contributionPlan">,
  assetIds: readonly string[],
  nameOf: ReadonlyMap<string, string>,
): Promise<Map<string, MyInvestorTwinLedger>> {
  if (assetIds.length === 0) return new Map();
  const ledgers = await store.operations.readHoldingLedgers(assetIds);
  const plans = await store.contributionPlan.readHoldingPlans(assetIds);
  return new Map(
    [...ledgers].map(([assetId, ledger]) => [
      assetId,
      {
        operations: ledger.operations,
        pairedWith: ledger.transferCounterparts.map((counterpart) => ({
          assetId: counterpart,
          name: nameOf.get(counterpart) ?? "otro holding",
        })),
        plan: plans.get(assetId) ?? null,
        ...(ledger.cachedPrice ? { cachedPrice: ledger.cachedPrice } : {}),
        ...(ledger.manualPrice ? { manualPrice: ledger.manualPrice } : {}),
      },
    ]),
  );
}

/**
 * The stored discovery and the fold built from it, or null when there is none to show.
 * `rates` are the ECB rates the fold converted its orders in another currency with
 * (#1899): the include plans with the very same. `fx` swaps the ECB (tests).
 */
export async function loadMyInvestorFirstStart(
  store: MyInvestorFoldStore,
  sourceId: string,
  today: string,
  options: { fx?: ResolveFxRateSnapshotOptions } = {},
): Promise<{
  discovery: MyInvestorDiscovery;
  view: MyInvestorFirstStartView;
  rates: FxRateSnapshot;
} | null> {
  const row = await store.connectedSources.readDiscovery(sourceId);
  const discovery = row ? parseMyInvestorDiscovery(row.payloadJson) : null;
  if (!discovery) return null;
  const rates = await resolveMyInvestorRates(discovery, options.fx);
  const links = await store.connectedSources.readLinks(sourceId);
  const linkedKeys = new Set(links.map((link) => link.productKey));
  const assets = await store.assets.readAssets();
  const portfolios = await store.managedPortfolios.readManagedPortfolios();
  const twins = findMyInvestorTwins(discovery, {
    linkedKeys,
    cash: manualCashAccounts(portfolios, assets),
    manual: manualHoldings(portfolios, assets),
  });
  const publicIds = managedPortfolioPublicIdIndex(
    await store.agentView.readPublicIds(),
  ).publicByInternal;
  const portfolioTwins = findMyInvestorPortfolioTwins(discovery, {
    linkedKeys,
    portfolios: manualPortfolios(portfolios, assets, (id) => {
      const publicId = publicIds.get(id);
      return publicId ? managedPortfolioFichaHref(publicId) : null;
    }),
  });
  // The portfolio each linked robo-advisor block lives in: what its manager bought
  // since joins it there (#1883). Read off its members, never a stored pointer.
  const assetOfKey = new Map(links.map((link) => [link.productKey, link.assetId]));
  const connectedPortfolios = new Map<string, { portfolioId: string; name: string }>();
  for (const product of discovery.products) {
    if (!product.portfolioKey) continue;
    const assetId = assetOfKey.get(product.key);
    const portfolio = assetId
      ? portfolios.find((candidate) => candidate.holdingIds.includes(assetId))
      : undefined;
    if (portfolio && !connectedPortfolios.has(product.portfolioKey)) {
      connectedPortfolios.set(product.portfolioKey, {
        name: portfolio.name,
        portfolioId: portfolio.id,
      });
    }
  }
  // Only the candidates' ledgers are read, all of them at once: the holdings a
  // product may be, and the investment members of the portfolios a block may be.
  const candidates = [
    ...new Set([
      ...[...twins.values()].flatMap((match) => match.holdings.map((h) => h.id)),
      ...[...portfolioTwins.values()].flatMap((list) =>
        list.flatMap((portfolio) =>
          portfolio.members
            .filter((member) => member.type === "investment")
            .map((member) => member.id),
        ),
      ),
    ]),
  ];
  const view = myInvestorFirstStartView(discovery, {
    ledgers: await twinLedgers(
      store,
      candidates,
      new Map(assets.map((asset) => [asset.id, asset.name])),
    ),
    linkedKeys,
    connectedPortfolios,
    portfolioTwins,
    rates,
    sourceId,
    today,
    twins,
  });
  return { discovery, rates, view };
}

/**
 * «Incluir N y traer su histórico», and later «Incluir con su histórico»: the chosen
 * products become linked holdings with their whole history, and the chosen twins
 * link their manual holdings (#1881), in ONE batch.
 */
export async function includeMyInvestorProducts(
  deps: {
    store: MyInvestorFirstStartStore;
    resolveSymbol: MyInvestorSymbolResolver;
    newAssetId: () => string;
    today: string;
    /** Swaps the ECB the orders in another currency are converted with (tests). */
    fx?: ResolveFxRateSnapshotOptions;
  },
  input: {
    sourceId: string;
    productKeys: readonly string[];
    links?: readonly MyInvestorLinkChoice[];
  },
): Promise<
  MyInvestorFlowResult & { created?: number; linked?: string[]; applied?: number }
> {
  if (!(await readConnection(deps.store, input.sourceId))) {
    return { error: MYINVESTOR_NOT_FOUND, ok: false };
  }
  const loaded = await loadMyInvestorFirstStart(deps.store, input.sourceId, deps.today, {
    ...(deps.fx ? { fx: deps.fx } : {}),
  });
  if (!loaded) return { error: MYINVESTOR_NOTHING_READ, ok: false };

  const workspace = await deps.store.workspace.readWorkspace();
  const member = workspace?.members.find((candidate) => !candidate.disabledAt);
  if (!member) return { error: "Workspace no inicializado.", ok: false };
  // The alta's default (#593): the holding is 100 % the connecting member's.
  const ownership: OwnershipShare[] = [{ memberId: member.id, shareBps: 10_000 }];

  const keys = [...new Set(input.productKeys)];
  const ids = new Map<string, string>();
  const assetIdFor = (key: string): string => {
    const known = ids.get(key);
    if (known) return known;
    const fresh = deps.newAssetId();
    ids.set(key, fresh);
    return fresh;
  };
  // A robo-advisor's block brings its funds (#1883): their symbols are looked up too.
  const blockKeys = new Set([
    ...keys,
    ...(input.links ?? []).map((link) => link.productKey),
  ]);
  const quoted = [
    ...keys,
    ...loaded.discovery.products
      .filter((product) => product.portfolioKey && blockKeys.has(product.portfolioKey))
      .map((product) => product.key),
  ];
  // The price symbols are looked up before the batch opens: a provider's network
  // has no place inside the transaction. A product nobody quotes is valued at cost.
  const symbols = new Map<string, MyInvestorPriceSymbol | null>();
  for (const key of quoted) {
    const product = loaded.discovery.products.find((candidate) => candidate.key === key);
    if (!product?.instrument) continue;
    const instrument =
      product.kind === "plan"
        ? "pension_plan"
        : product.kind === "etf" || product.kind === "stock"
          ? product.kind
          : "fund";
    symbols.set(key, await deps.resolveSymbol(product.instrument.code, instrument));
  }

  // A way out an earlier pass applied as a sale (#1882): its entry, included now,
  // goes in pending, as the sync writes it — never as half a traspaso.
  const linkedBooks = await deps.store.operations.readHoldingLedgers(
    (await deps.store.connectedSources.readLinks(input.sourceId)).map(
      (link) => link.assetId,
    ),
  );
  const plan = planMyInvestorInclusion(loaded.discovery, {
    assetIdFor,
    links: input.links ?? [],
    ownership,
    productKeys: keys,
    rates: loaded.rates,
    soldUnpairedOutIds: soldUnpairedOutIds(
      new Map([...linkedBooks].map(([assetId, ledger]) => [assetId, ledger.operations])),
    ),
    sourceId: input.sourceId,
    symbols,
    today: deps.today,
    view: loaded.view,
  });
  if (!plan.ok) return plan;

  const result = await deps.store.command.includeConnectedHoldings(plan.command);
  // The success band names what is now MyInvestor's (#1881, design C): a holding,
  // or a portfolio kept by hand (#1883).
  const names = new Map([
    ...loaded.view.rows.flatMap((row) =>
      (row.twin?.candidates ?? []).map((item) => [item.assetId, item.name] as const),
    ),
    ...loaded.view.rows.flatMap((row) =>
      (row.portfolioTwin?.candidates ?? []).map(
        (item) => [item.portfolioId, item.name] as const,
      ),
    ),
  ]);
  const linked = (input.links ?? []).map(
    (link) => names.get(link.assetId) ?? link.assetId,
  );
  return { applied: result.applied, created: result.created, linked, ok: true };
}

/** The provider a symbol found by `searchSymbols` belongs to, narrowed. */
export function isInvestmentPriceProvider(
  value: string,
): value is InvestmentPriceProvider {
  return (
    value === "yahoo" || value === "finect" || value === "coingecko" || value === "stooq"
  );
}
