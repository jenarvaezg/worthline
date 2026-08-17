import {
  connectBinanceAction,
  recredentialBinanceAction,
  syncBinanceAction,
} from "@web/ajustes/binance-actions";
import {
  aggregateSourceValueMinor,
  countNonDustTokens,
} from "@web/ajustes/binance-helpers";
import {
  BINANCE_CONNECT_FORM_ID,
  BINANCE_CREDENTIALS_FORM_ID,
  NUMISTA_CONNECT_FORM_ID,
  NUMISTA_CREDENTIALS_FORM_ID,
} from "@web/ajustes/connected-source-form-ids";
import DisconnectBinanceFold from "@web/ajustes/disconnect-binance-fold";
import DisconnectNumistaFold from "@web/ajustes/disconnect-numista-fold";
import {
  connectNumistaAction,
  recredentialNumistaAction,
  syncNumistaAction,
} from "@web/ajustes/numista-actions";
import { countCoins } from "@web/ajustes/numista-helpers";
import type { ComponentType, ReactNode } from "react";
import {
  CONNECTION_ADAPTERS,
  type ConnectionAdapter,
  type ConnectionDataDefinition,
} from "./connection-rows";

/**
 * El registry de UI de las fuentes conectadas (#1223, PRD #1222).
 *
 * Es SOLO presentación: qué se llama la fuente, qué materializa, qué
 * credenciales pide y qué acciones la mueven. El dominio no cambia — cada
 * adapter conserva sus Server Actions explícitas (ADR 0043) y su fold de
 * desconexión; lo que se unifica aquí es el render.
 *
 * Añadir una fuente = una entrada más en `CONNECTION_REGISTRY`. Cero JSX nuevo.
 */

export interface CredentialField {
  name: string;
  label: string;
  placeholder: string;
}

export interface ConnectionDefinition extends ConnectionDataDefinition {
  /** El nombre del proveedor tal cual se imprime en la fila. */
  label: string;
  /** Qué materializa la fuente en worthline, bajo el nombre del proveedor. */
  mirrors: string;
  /** El `formId` con el que la action de CONECTAR marca sus errores. */
  formId: string;
  /**
   * El `formId` de la action de cambiar credenciales (#1225). Distinto del de
   * conectar: los dos pliegues no son el mismo, y un error debe reabrir el que lo
   * produjo — nunca el otro, que hablaría de un formulario que no se envió.
   */
  credentialsFormId: string;
  /** Sustantivo de lo que cuenta la columna «Elementos». */
  unitLabel: string;
  fields: CredentialField[];
  /** El texto que acompaña al formulario de conectar. */
  intro: ReactNode;
  connectAction: (formData: FormData) => void | Promise<void>;
  connectLabel: string;
  /** Cambiar las credenciales de una fuente ya conectada, sin desconectarla (#1225). */
  recredentialAction: (formData: FormData) => void | Promise<void>;
  recredentialLabel: string;
  syncAction: (formData: FormData) => void | Promise<void>;
  syncLabel: string;
  /** El enlace a la ficha del activo espejo. */
  viewLabel: string;
  DisconnectFold: ComponentType<{
    currentUrl: string;
    sourceId: string;
    summary?: string;
  }>;
}

const numista: ConnectionDefinition = {
  adapter: "numista",
  label: "Numista",
  mirrors: "Colección de monedas",
  formId: NUMISTA_CONNECT_FORM_ID,
  credentialsFormId: NUMISTA_CREDENTIALS_FORM_ID,
  unitLabel: "monedas",
  countUnits: countCoins,
  // Numista ocupa un solo peldaño: su valor es el del activo espejo.
  valueMinor: ({ assets, primaryAssetId }) =>
    assets.find((asset) => asset.id === primaryAssetId)?.currentValue.amountMinor ?? 0,
  fields: [
    {
      name: "apiKey",
      label: "Clave de API de Numista",
      placeholder: "Pega aquí tu clave de API",
    },
  ],
  intro: (
    <>
      Conecta tu colección de Numista para reflejar tus monedas como un activo ilíquido
      con valor calculado. Usa una clave de solo lectura; se guarda cifrada y nunca se
      exporta.
    </>
  ),
  connectAction: connectNumistaAction,
  connectLabel: "Conectar Numista",
  recredentialAction: recredentialNumistaAction,
  recredentialLabel: "Guardar la clave nueva",
  syncAction: syncNumistaAction,
  syncLabel: "Sincronizar Numista",
  viewLabel: "Ver colección →",
  DisconnectFold: DisconnectNumistaFold,
};

const binance: ConnectionDefinition = {
  adapter: "binance",
  label: "Binance",
  mirrors: "Cuenta de Binance",
  formId: BINANCE_CONNECT_FORM_ID,
  credentialsFormId: BINANCE_CREDENTIALS_FORM_ID,
  unitLabel: "tokens",
  countUnits: countNonDustTokens,
  // Binance ocupa VARIOS peldaños (mercado + bloqueado a plazo, #248): su valor
  // es la suma de los activos de la fuente, no el del activo espejo.
  valueMinor: ({ assets, sourceAssetIds }) =>
    aggregateSourceValueMinor(assets, new Set(sourceAssetIds)),
  fields: [
    {
      name: "apiKey",
      label: "Clave de API de Binance",
      placeholder: "Pega aquí tu clave de API",
    },
    {
      name: "apiSecret",
      label: "Secreto de API de Binance",
      placeholder: "Pega aquí tu secreto de API",
    },
  ],
  intro: (
    <>
      Conecta tu cuenta de Binance para reflejar tus tokens como un activo valorado en
      vivo. Usa <strong>obligatoriamente</strong> una clave de{" "}
      <strong>solo lectura</strong> («Enable Reading»), sin permisos de trading ni de
      retiro: worthline solo lee saldos. La clave y el secreto se guardan{" "}
      <strong>cifrados</strong> y nunca se exportan.
    </>
  ),
  connectAction: connectBinanceAction,
  connectLabel: "Conectar Binance",
  recredentialAction: recredentialBinanceAction,
  recredentialLabel: "Guardar las credenciales nuevas",
  syncAction: syncBinanceAction,
  syncLabel: "Sincronizar Binance",
  viewLabel: "Ver →",
  DisconnectFold: DisconnectBinanceFold,
};

/**
 * El registry, en el orden de `CONNECTION_ADAPTERS`. Derivarlo del mismo array
 * que cuenta `/ajustes` deja una sola lista de adapters: una entrada nueva sin
 * su definición (o al revés) no compila.
 */
const BY_ADAPTER: Record<ConnectionAdapter, ConnectionDefinition> = { binance, numista };

export const CONNECTION_REGISTRY: ConnectionDefinition[] = CONNECTION_ADAPTERS.map(
  (adapter) => BY_ADAPTER[adapter],
);
