/**
 * The health of a connection that owns its holdings, as data health says it (#1885,
 * PRD #1876 S10, «en salud de datos, como cualquier fuente»).
 *
 * The rules are {@link owningSourceHealth}'s, the same ones the ficha's band and the
 * Conexiones row read, so the three cannot disagree. This family only turns each
 * notice into a signal of the `source_freshness` family, which links to
 * `/ajustes/conexiones`: that is where each one is put right (verify the phone, save
 * the password, «Poner al día»).
 *
 * Such a connection replaces the generic count of failed runs
 * (`PERSISTENT_SYNC_FAILURE`, two in a row): its attempt log holds every press of
 * the button, and two wrong passwords typed in a minute are not a connector that
 * fails. Its rule is three DAYS, per kind of data.
 */

import {
  type DataQualityCollector,
  type DataQualitySignal,
  dateOnly,
  signalNaturalKey,
} from "./data-quality-collector";
import {
  type DataQualityConnectedSource,
  sourceIsInScope,
} from "./data-quality-connected-source";
import type { DataQualityPersistentSyncFailureInput } from "./data-quality-persistent-sync-failure";
import {
  type OwningSourceDataKind,
  type OwningSourceHealthNotice,
  type OwningSourceStop,
  owningSourceHealth,
} from "./owning-source-health";

/** The periodic sync is stopped until the user acts (the SMS, the rejected password). */
export const OWNING_SOURCE_STOPPED_CODE = "OWNING_SOURCE_STOPPED";
/** No saved password and 45 days without a good sync. */
export const OWNING_SOURCE_UNSYNCED_CODE = "OWNING_SOURCE_UNSYNCED";
/** «El conector falla», one code per kind of data so each is its own signal. */
export const OWNING_SOURCE_FAILING_CODES: Record<OwningSourceDataKind, string> = {
  orders: "OWNING_SOURCE_FAILING_ORDERS",
  plans: "OWNING_SOURCE_FAILING_PLANS",
  positions: "OWNING_SOURCE_FAILING_POSITIONS",
};

/** The attempts and the standing (`DataQualityPersistentSyncFailureInput`), and the day. */
export interface DataQualityOwningSourceHealthInput
  extends DataQualityPersistentSyncFailureInput {
  asOfDateKey: string;
}

const DATA_WORDS: Record<OwningSourceDataKind, { read: string; effect: string }> = {
  orders: { effect: "las operaciones nuevas pueden faltar", read: "las órdenes" },
  plans: { effect: "los planes pueden no estar al día", read: "los planes" },
  positions: {
    effect: "las cifras siguen en la última sincronización buena",
    read: "las posiciones",
  },
};

const STOP_WORDS: Record<OwningSourceStop, (label: string) => string> = {
  password_forgotten: (label) =>
    `"${label}" no acepta la contraseña guardada y worthline la ha borrado: la puesta al día diaria está parada.`,
  sms_required: (label) =>
    `"${label}" pide verificar el móvil otra vez: la puesta al día diaria está parada hasta que lo hagas.`,
};

export const collectOwningSourceHealthSignals: DataQualityCollector<
  DataQualityOwningSourceHealthInput
> = (input) => {
  const signals: DataQualitySignal[] = [];
  for (const source of input.connectedSources) {
    const standing = input.owningSourceStandingBySourceId.get(source.id);
    if (!standing || !sourceIsInScope(source, input.ownedAssetIds)) continue;
    const notices = owningSourceHealth(
      {
        attempts: input.syncAttemptsBySourceId.get(source.id) ?? [],
        lastSyncAt: source.lastSyncAt,
        savedPassword: standing.savedPassword,
        stop: standing.stop,
      },
      input.asOfDateKey,
    );
    for (const notice of notices) signals.push(signalOf(source, notice));
  }
  return signals;
};

function signalOf(
  source: DataQualityConnectedSource,
  notice: OwningSourceHealthNotice,
): DataQualitySignal {
  const base = (code: string) => ({
    affected: { id: source.id, label: source.label, object: "connected_source" as const },
    category: "source_freshness" as const,
    code,
    fixable: false,
    naturalKey: signalNaturalKey("source_freshness", code, source.id),
  });
  switch (notice.kind) {
    case "stop":
      return {
        ...base(OWNING_SOURCE_STOPPED_CODE),
        label: STOP_WORDS[notice.stop](source.label),
        severity: "high",
      };
    case "failing": {
      const words = DATA_WORDS[notice.data];
      return {
        ...base(OWNING_SOURCE_FAILING_CODES[notice.data]),
        label: `El conector de "${source.label}" falla al leer ${words.read} desde hace ${notice.days} días: ${words.effect}.`,
        observedDate: notice.since,
        // The plans do not move today's figure; the positions and the orders do.
        severity: notice.data === "plans" ? "medium" : "high",
      };
    }
    case "unsynced":
      return {
        ...base(OWNING_SOURCE_UNSYNCED_CODE),
        label: `Llevas ${notice.days} días sin poner al día "${source.label}". Sin la contraseña guardada, solo se pone al día cuando pulsas.`,
        ...(source.lastSyncAt === null
          ? {}
          : { observedDate: dateOnly(source.lastSyncAt) }),
        severity: "low",
      };
  }
}
