/**
 * The ficha of a holding a connected source OWNS (ADR 0115) — today, MyInvestor's
 * (#1884, design A of the issue). What every family that can be owned shares:
 *
 * - its header is read-only: no form writes its units (invariant 5), and the one
 *   habitual action is «Poner al día», which opens the panel of the pass;
 * - the figure that carries the units says who puts them and as of when;
 * - the band of avisos carries what the last pass left: the connection's lasting
 *   state with its remedy, and this holding's units when they do not square (P8);
 *   and the connection's health signals (#1885): «El conector falla» after three
 *   days in a row and the 45-day reminder, each with «Ver la conexión →».
 *
 * The families (investment, stored) ask here and place the pieces; they keep their
 * own tabs. No booleans in the page (#1607).
 */

import {
  type MyInvestorSchedule,
  myInvestorSchedulesByAsset,
} from "@web/ajustes/myinvestor-contributions";
import {
  hasSavedPassword,
  readMyInvestorCredentials,
} from "@web/ajustes/myinvestor-credentials";
import { parseMyInvestorDiscovery } from "@web/ajustes/myinvestor-discovery";
import { parseMyInvestorUnitsCheck } from "@web/ajustes/myinvestor-sync-outcome";
import MyInvestorSyncPanel from "@web/ajustes/myinvestor-sync-panel";
import {
  formatMyInvestorLastGood,
  MYINVESTOR_RESYNC_LABEL,
  type MyInvestorBandEntry,
  type MyInvestorStanding,
  myInvestorHealthEntries,
  myInvestorStanding,
  myInvestorUnitsLine,
} from "@web/ajustes/myinvestor-sync-view";
import { isWriteBlocked } from "@web/demo/write-guard";
import { fichaActionUrl } from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import type { WorthlineStore } from "@web/store";
import type { ConnectedSource } from "./connected-source";
import type { FichaAction, FichaSourceNotice } from "./family-contract";

/** «Poner al día»: its `?accion=`. */
export const PONER_AL_DIA_ACTION = "poner-al-dia";

/** The Conexiones row, where the SMS is verified again (#1879). */
const CONEXIONES = "/ajustes/conexiones";

/** What the ficha of an owned holding knows about its source, read once. */
export interface OwningSourceFicha {
  sourceId: string;
  /** «MyInvestor». */
  label: string;
  savedPassword: boolean;
  /** The last good sync, as the user reads it. */
  lastGood: string;
  standing: MyInvestorStanding;
  /** The connection's health signals from its attempt log (#1885). */
  health: readonly MyInvestorBandEntry[];
  /** This holding's units check, when they do not square. */
  unitsLine: string | null;
  /** Some linked holding does not square: the panel offers «Resincronizar todo». */
  anyMismatch: boolean;
  /**
   * The session cannot write — a viewer, the demo, an impersonating admin (ADR
   * 0114 decision 3): the panel is shown, never pressable, and never asks for the
   * holder's password.
   */
  readOnly: boolean;
}

/**
 * The source of an owned holding, as its ficha needs it, or null when the holding
 * is not one a source owns (a mirror's, or none).
 */
export async function loadOwningSourceFicha(
  store: WorthlineStore,
  source: ConnectedSource | null,
  assetId: string,
  now: string,
): Promise<OwningSourceFicha | null> {
  if (!source || source.adapter !== "myinvestor") return null;
  const [full, state, readOnly, attempts] = await Promise.all([
    store.connectedSources.readSource(source.id),
    store.connectedSources.readSyncState(source.id),
    isWriteBlocked(),
    // The same port data health counts the days on (#1885), so the two agree.
    store.agentView.readSyncAttempts(source.id),
  ]);
  const credentials = full ? readMyInvestorCredentials(full.credentialsJson) : null;
  const savedPassword = credentials !== null && hasSavedPassword(credentials);
  const check = parseMyInvestorUnitsCheck(state?.unitsCheckJson ?? null);
  const mine = check.find((entry) => entry.assetId === assetId) ?? null;
  return {
    anyMismatch: check.length > 0,
    health: myInvestorHealthEntries({
      attempts,
      lastSyncAt: source.lastSyncAt,
      now,
      savedPassword,
      state,
    }),
    label: source.label,
    lastGood: formatMyInvestorLastGood(source.lastSyncAt, now),
    readOnly,
    savedPassword,
    sourceId: source.id,
    standing: myInvestorStanding({ now, savedPassword, state }),
    unitsLine: mine ? myInvestorUnitsLine(mine) : null,
  };
}

/** A linked holding's scheduled contributions, and the day they were read. */
export interface OwningSourceSchedules {
  schedules: MyInvestorSchedule[];
  /** The day of the last read: whether a window has closed is measured against it. */
  readOn: string;
}

/**
 * The scheduled contributions MyInvestor has for this holding (#1886), from the
 * stored read the last pass refreshed — never from MyInvestor itself. Null when
 * the holding is not owned or there is no read; an empty list when it has none.
 * Takes the source, not the loaded ficha, so it runs in the same wave.
 */
export async function loadOwningSourceSchedules(
  store: WorthlineStore,
  source: ConnectedSource | null,
  assetId: string,
  today: string,
): Promise<OwningSourceSchedules | null> {
  if (!source || source.adapter !== "myinvestor") return null;
  const [row, links] = await Promise.all([
    store.connectedSources.readDiscovery(source.id),
    store.connectedSources.readLinks(source.id),
  ]);
  const discovery = row ? parseMyInvestorDiscovery(row.payloadJson) : null;
  if (!discovery) return null;
  return {
    readOn: discovery.readOn,
    schedules: myInvestorSchedulesByAsset(discovery, links, today).get(assetId) ?? [],
  };
}

/** The primary action: «Poner al día», with the panel of the pass. */
export function ponerAlDiaAction(
  owned: OwningSourceFicha,
  input: { currentUrl: string; readOnly: boolean },
): FichaAction {
  return {
    content: (
      <MyInvestorSyncPanel
        blockedLine={owned.standing.blocked?.line ?? null}
        currentUrl={input.currentUrl}
        dailyLine={owned.standing.dailyLine}
        lastGood={owned.lastGood}
        layout="panel"
        lastLine={owned.standing.lastLine}
        readOnly={input.readOnly || owned.readOnly}
        resync={owned.anyMismatch}
        runningSince={owned.standing.running?.since ?? null}
        savedPassword={owned.savedPassword}
        sourceId={owned.sourceId}
      />
    ),
    key: PONER_AL_DIA_ACTION,
    label: owned.standing.running ? "Poniendo al día…" : "Poner al día",
    tier: "primary",
  };
}

/** Who puts the units, and as of when: under the figure that carries them. */
export function owningSourceCaption(owned: OwningSourceFicha): string {
  return `Las pone ${owned.label} · al día ${owned.lastGood}`;
}

/**
 * What the band carries for an owned holding: the connection's lasting state and
 * this holding's units, each with its remedy resolved against the ficha's tabs.
 * The slot of the connection's health signals (#1885) is this same list.
 */
export function owningSourceNotices(
  owned: OwningSourceFicha,
  input: { currentUrl: string; tabs: readonly string[] },
): FichaSourceNotice[] {
  const panel = (label: string) => ({
    action: PONER_AL_DIA_ACTION,
    // The panel opens over the ficha's default tab, as from its bar.
    href: fichaActionUrl(
      input.currentUrl,
      input.tabs,
      input.tabs[0] ?? "",
      PONER_AL_DIA_ACTION,
    ),
    label,
  });
  const notices: FichaSourceNotice[] = [];
  const lasting = owned.standing.lasting;
  if (lasting) {
    notices.push({
      key: "connection",
      remedy:
        lasting.remedy === null
          ? null
          : lasting.remedy.kind === "conexiones"
            ? { href: CONEXIONES, label: lasting.remedy.label }
            : panel(lasting.remedy.label),
      text: owned.standing.blocked
        ? `${lasting.text} ${owned.standing.blocked.line}`
        : lasting.text,
    });
  }
  owned.health.forEach((entry, index) => {
    notices.push({
      key: `health-${index}`,
      remedy:
        entry.remedy === null
          ? null
          : entry.remedy.kind === "conexiones"
            ? { href: CONEXIONES, label: entry.remedy.label }
            : panel(entry.remedy.label),
      text: entry.text,
    });
  });
  if (owned.unitsLine) {
    notices.push({
      key: "units",
      remedy: panel(MYINVESTOR_RESYNC_LABEL),
      text: owned.unitsLine,
    });
  }
  return notices;
}
