import { withStore, type WorthlineStore } from "@worthline/db";
import type {
  AdapterPositionDraft,
  ConnectedSourceAdapter,
  SyncContext,
} from "@worthline/pricing";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  appendParam,
  errorRedirectUrl,
  parseScopeCookie,
  SCOPE_COOKIE_NAME,
} from "../intake";
import { resolveConnectingOwnership } from "./numista-helpers";

/**
 * The generic connected-source lifecycle (ADR 0027, #319).
 *
 * One connect / sync / disconnect shape every provider shares, parameterized by a
 * `ConnectedSourceAdapter`. Each provider's `*-actions.ts` shrinks to thin wrappers
 * that pass its adapter (+ the provider-specific reader wiring for sync) into these
 * functions. This module owns the shape that used to be duplicated across
 * numista-actions.ts / binance-actions.ts:
 *   - connect: read workspace → reject 2nd source of the tag → resolve ownership →
 *     store.connectedSources.connect → redirect ok / error.
 *   - sync: read creds INSIDE the store → await the network OUTSIDE it →
 *     adapter.listPositions → write positions INSIDE the store → redirect.
 *   - disconnect: freeze (freezeIntoStoredHolding) vs remove (drop the holding,
 *     FK-cascading the source + positions) → redirect.
 *
 * It keeps the read-creds-sync / await-network / write-sync ordering the sync-only
 * `withStore` demands, the `_store?` test seam (`runWith`), and the redirect/error
 * vocabulary. The provider keeps ONLY its parsing + network (in the adapter/helpers).
 */

export const BASE = "/ajustes";

/** The return URL carried on every connected-source form. */
export function currentUrlOf(formData: FormData): string {
  return (formData.get("currentUrl") as string) || BASE;
}

/** Run `fn` against the injected test store when present, else a real `withStore`
 *  transaction — the `_store?` seam that keeps the actions integration-testable. */
export function runWith<T>(fn: (store: WorthlineStore) => T, _store?: WorthlineStore): T {
  return _store ? fn(_store) : withStore(fn);
}

/** Resolve the active scope member id from the cookie (the connecting member). */
export async function scopeMemberId(): Promise<string | undefined> {
  const jar = await cookies();
  return parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
}

/** The provider-specific vocabulary the generic connect needs (a tiny bundle so
 *  the shared shape stays provider-agnostic while the copy stays per-provider). */
export interface ConnectMessages {
  /** The form id the error banner re-opens (e.g. "numista"). */
  formId: string;
  /** Shown when the form carried no usable credentials. */
  missingCredentials: string;
  /** Shown when a source of this tag is already connected. */
  alreadyConnected: string;
  /** Shown when there is no active member to own the holding. */
  noOwner: string;
  /** The display label of the projected holding(s). */
  label: string;
  /** The `ok` query value on a successful connect (e.g. "numista_connected"). */
  okParam: string;
}

/**
 * Generic connect: parse the form via the adapter → reject a second source of the
 * tag → resolve 100%-connecting-member ownership → persist the source row. Redirects
 * (never returns). The credentials are a SECRET: serialized for the local DB only,
 * never logged nor placed in a redirect URL.
 */
export async function connectSource<Creds, Token>(
  adapter: ConnectedSourceAdapter<Creds, Token>,
  formData: FormData,
  messages: ConnectMessages,
  _store?: WorthlineStore,
): Promise<never> {
  const creds = adapter.parseConnectForm(formData);
  const returnUrl = currentUrlOf(formData);

  if (!creds) {
    redirect(
      errorRedirectUrl(returnUrl, {
        formId: messages.formId,
        message: messages.missingCredentials,
      }),
    );
  }

  const scoped = await scopeMemberId();

  const result = runWith((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false as const, error: "Workspace no inicializado." };
    }

    // For now only one source per provider is allowed — a second connect is
    // refused so the settings page shows the existing one as connected instead.
    const existing = store.connectedSources
      .listSources()
      .find((source) => source.adapter === adapter.tag);

    if (existing) {
      return { ok: false as const, error: messages.alreadyConnected };
    }

    const ownership = resolveConnectingOwnership(workspace.members, scoped);

    if (!ownership) {
      return { ok: false as const, error: messages.noOwner };
    }

    store.connectedSources.connect({
      adapter: adapter.tag,
      label: messages.label,
      credentialsJson: adapter.serializeCredentials(creds),
      ownership,
    });

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(returnUrl, { formId: messages.formId, message: result.error }),
    );
  }

  redirect(appendParam(returnUrl, "ok", messages.okParam));
}

/** The provider-specific copy + reader wiring the generic sync needs. */
export interface SyncWiring<Creds, Token> {
  /** Shown when the source id is missing / unknown (never wipes positions). */
  notFound: string;
  /** Shown when the stored credentials cannot be read (re-connect needed). */
  missingCredentials: string;
  /** Shown when the network round-trip fails (positions left untouched). */
  syncFailed: string;
  /** The `ok` query value on a successful sync (e.g. "numista_synced"). */
  okParam: string;
  /**
   * Build the adapter's `SyncContext` — the token-bound network readers + clock —
   * from the read credentials. Provider-specific (Numista mints/refreshes the
   * OAuth token here and persists it via `persistToken`; Binance signs per call).
   * Awaited OUTSIDE the store write, as the sync ordering demands.
   */
  buildContext: (args: {
    creds: Creds;
    token: Token | null;
    nowIso: string;
    nowMs: number;
    persistToken: (token: Token) => void;
  }) => Promise<SyncContext<Creds, Token>>;
  /** Parse the stored token JSON into the cached token, or null when absent/bad. */
  parseToken: (tokenJson: string | null) => Token | null;
  /** Apply provider-specific post-write effects (e.g. Binance's fresh stamp +
   *  best-effort history backfill). Runs after positions are written; failures in
   *  best-effort steps must be swallowed by the provider. Omit for a plain sync. */
  afterWrite?: (args: {
    sourceId: string;
    nowIso: string;
    nowMs: number;
    creds: Creds;
    drafts: AdapterPositionDraft[];
    runWith: <T>(fn: (store: WorthlineStore) => T) => T;
  }) => Promise<void>;
}

/**
 * Generic sync: read the creds + token INSIDE the store → mint/refresh + list the
 * positions OUTSIDE it (via the adapter) → write them INSIDE the store → redirect.
 * On any network failure, redirect with a clear message and DO NOT touch existing
 * positions (we never reach the write). Redirects (never returns).
 */
export async function syncSource<Creds, Token>(
  adapter: ConnectedSourceAdapter<Creds, Token>,
  sourceId: string | null,
  wiring: SyncWiring<Creds, Token>,
  returnUrl: string,
  _store?: WorthlineStore,
): Promise<never> {
  if (!sourceId) {
    redirect(errorRedirectUrl(returnUrl, { message: wiring.notFound }));
  }

  // 1) Read the credentials + token (sync, inside the store).
  const source = runWith((store) => store.connectedSources.readSource(sourceId), _store);

  if (!source) {
    redirect(errorRedirectUrl(returnUrl, { message: wiring.notFound }));
  }

  const creds = adapter.readCredentials(source.credentialsJson);

  if (!creds) {
    redirect(errorRedirectUrl(returnUrl, { message: wiring.missingCredentials }));
  }

  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // 2) Network: list + value the positions (the adapter owns the round-trip). On
  // any failure, redirect with a clear message and leave existing positions intact.
  try {
    const token = wiring.parseToken(source.tokenJson);
    const ctx = await wiring.buildContext({
      creds,
      token,
      nowIso,
      nowMs,
      persistToken: (next) =>
        runWith(
          (store) => store.connectedSources.saveToken(sourceId, JSON.stringify(next)),
          _store,
        ),
    });

    const drafts = await adapter.listPositions(ctx);

    // 3) Write: replace positions, re-roll the holding value, stamp last sync.
    runWith(
      (store) =>
        store.syncConnectedSource({ positions: drafts, sourceId, syncedAt: nowIso }),
      _store,
    );

    // 4) Provider-specific post-write effects (best-effort; the provider swallows).
    if (wiring.afterWrite) {
      await wiring.afterWrite({
        sourceId,
        nowIso,
        nowMs,
        creds,
        drafts,
        runWith: (fn) => runWith(fn, _store),
      });
    }
  } catch {
    redirect(errorRedirectUrl(returnUrl, { message: wiring.syncFailed }));
  }

  redirect(appendParam(returnUrl, "ok", wiring.okParam));
}

/** The provider-specific copy the generic disconnect needs. */
export interface DisconnectMessages {
  notFound: string;
  freezeFailed: string;
  removeFailed: string;
  frozenParam: string;
  disconnectedParam: string;
}

/**
 * Generic disconnect (PRD #160 story 21 / #245 S6, ADR 0016): "freeze" keeps the
 * holding(s) as plain hand-maintained ones (drop the source, flip the instrument);
 * "remove" (the default) drops the live holding(s) — the FK cascade removes the
 * source + positions — while frozen snapshots keep the history. Redirects.
 */
export async function disconnectSource(
  sourceId: string | null,
  freeze: boolean,
  messages: DisconnectMessages,
  returnUrl: string,
  _store?: WorthlineStore,
): Promise<never> {
  if (!sourceId) {
    redirect(errorRedirectUrl(returnUrl, { message: messages.notFound }));
  }

  const result = runWith((store) => {
    const source = store.connectedSources.readSource(sourceId);

    if (!source) {
      return { ok: false as const, error: messages.notFound };
    }

    if (freeze) {
      const frozen = store.connectedSources.freezeIntoStoredHolding(sourceId);

      if (!frozen) {
        return { ok: false as const, error: messages.freezeFailed };
      }

      return { ok: true as const, message: messages.frozenParam };
    }

    // Remove ALL the source's materialized holdings in ONE transaction: deleting
    // the market (primary) asset cascades the source row + its positions away; the
    // other-rung assets (no back-FK) are removed explicitly.
    const { removed } = store.connectedSources.removeSourceHoldings(sourceId);

    if (removed === 0) {
      return { ok: false as const, error: messages.removeFailed };
    }

    return { ok: true as const, message: messages.disconnectedParam };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { message: result.error }));
  }

  redirect(appendParam(returnUrl, "ok", result.message));
}
