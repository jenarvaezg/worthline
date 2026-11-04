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
 *    what was left out never asks MyInvestor again.
 */
import type { WorthlineStore } from "@web/store";
import type { InvestmentPriceProvider, OwnershipShare } from "@worthline/domain";
import type {
  MyInvestorClient,
  MyInvestorErrorKind,
  MyInvestorReader,
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
import {
  type MyInvestorPriceSymbol,
  myInvestorFirstStartView,
  planMyInvestorInclusion,
} from "./myinvestor-first-start";
import type { MyInvestorFirstStartView } from "./myinvestor-selection";

const MYINVESTOR_ADAPTER = "myinvestor";

export const MYINVESTOR_READ_FAILED =
  "No hemos podido leer tus productos de MyInvestor. No se ha guardado nada; vuelve a intentarlo en unos minutos.";
export const MYINVESTOR_PASSWORD_NEEDED =
  "Escribe tu contraseña de MyInvestor para leer tus productos. No se guarda.";
export const MYINVESTOR_DEVICE_FORGOTTEN =
  "MyInvestor ya no reconoce este dispositivo. Desconecta y vuelve a conectar para recibir el SMS.";
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
};

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
  },
  input: { sourceId: string; reader: MyInvestorReader },
): Promise<MyInvestorFlowResult> {
  let discovery: MyInvestorDiscovery;
  try {
    discovery = await readMyInvestorDiscovery(input.reader, deps.today);
  } catch (error) {
    if (error instanceof MyInvestorSyncError) {
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
  },
  input: { sourceId: string; typed: { customerId: string; password: string } | null },
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
  if (!tokens.ok) return { error: readErrorMessage(tokens.error.kind), ok: false };
  return storeMyInvestorDiscovery(deps, {
    reader: client.reader(tokens.value),
    sourceId: input.sourceId,
  });
}

/** The live MANUAL holdings by the ISIN or DGS code they carry: S6's twins. */
async function manualTwins(
  store: Pick<MyInvestorFirstStartStore, "assets">,
): Promise<Map<string, string>> {
  const twins = new Map<string, string>();
  for (const asset of await store.assets.readAssets()) {
    if (asset.connectedSourceId != null) continue;
    const code = asset.securityId?.value;
    if (code && !twins.has(code)) twins.set(code, asset.name);
  }
  return twins;
}

/** The stored discovery and the fold built from it, or null when there is none to show. */
export async function loadMyInvestorFirstStart(
  store: Pick<MyInvestorFirstStartStore, "connectedSources" | "assets">,
  sourceId: string,
): Promise<{ discovery: MyInvestorDiscovery; view: MyInvestorFirstStartView } | null> {
  const row = await store.connectedSources.readDiscovery(sourceId);
  const discovery = row ? parseMyInvestorDiscovery(row.payloadJson) : null;
  if (!discovery) return null;
  const links = await store.connectedSources.readLinks(sourceId);
  const view = myInvestorFirstStartView(discovery, {
    linkedKeys: new Set(links.map((link) => link.productKey)),
    manualTwins: await manualTwins(store),
    sourceId,
  });
  return { discovery, view };
}

/**
 * «Incluir N y traer su histórico», and later «Incluir con su histórico»: the chosen
 * products become linked holdings with their whole history, in ONE batch.
 */
export async function includeMyInvestorProducts(
  deps: {
    store: MyInvestorFirstStartStore;
    resolveSymbol: MyInvestorSymbolResolver;
    newAssetId: () => string;
    today: string;
  },
  input: { sourceId: string; productKeys: readonly string[] },
): Promise<MyInvestorFlowResult & { created?: number; applied?: number }> {
  if (!(await readConnection(deps.store, input.sourceId))) {
    return { error: MYINVESTOR_NOT_FOUND, ok: false };
  }
  const loaded = await loadMyInvestorFirstStart(deps.store, input.sourceId);
  if (!loaded) return { error: MYINVESTOR_NOTHING_READ, ok: false };

  const workspace = await deps.store.workspace.readWorkspace();
  const member = workspace?.members.find((candidate) => !candidate.disabledAt);
  if (!member) return { error: "Workspace no inicializado.", ok: false };
  // The alta's default (#593): the holding is 100 % the connecting member's.
  const ownership: OwnershipShare[] = [{ memberId: member.id, shareBps: 10_000 }];

  const keys = [...new Set(input.productKeys)];
  const ids = new Map(keys.map((key) => [key, deps.newAssetId()]));
  // The price symbols are looked up before the batch opens: a provider's network
  // has no place inside the transaction. A product nobody quotes is valued at cost.
  const symbols = new Map<string, MyInvestorPriceSymbol | null>();
  for (const key of keys) {
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

  const plan = planMyInvestorInclusion(loaded.discovery, {
    assetIdFor: (key) => ids.get(key)!,
    ownership,
    productKeys: keys,
    sourceId: input.sourceId,
    symbols,
    today: deps.today,
    view: loaded.view,
  });
  if (!plan.ok) return plan;

  const result = await deps.store.command.includeConnectedHoldings(plan.command);
  return { applied: result.applied, created: result.created, ok: true };
}

/** The provider a symbol found by `searchSymbols` belongs to, narrowed. */
export function isInvestmentPriceProvider(
  value: string,
): value is InvestmentPriceProvider {
  return (
    value === "yahoo" || value === "finect" || value === "coingecko" || value === "stooq"
  );
}
