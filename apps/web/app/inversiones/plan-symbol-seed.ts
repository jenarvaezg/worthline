/**
 * El reintento de la ficha: sembrar el símbolo de precio de un plan desde su
 * código DGS (#1746, variante A de #1669).
 *
 * El alta no bloquea nunca. Si Finect estaba caído, lento, o el código todavía no
 * era el bueno, el plan nace **identificado y sin cotizar** —un estado legítimo
 * (invariante 6 del PRD #1741)— y salud de datos lo recoge. Este módulo es la
 * salida que ese aviso promete: el mismo `searchSymbols` que usa el alta, con el
 * mismo instrumento, para que el símbolo que llega por reintento sea exactamente
 * el que habría llegado en el alta.
 *
 * No lanza: `searchSymbols` degrada cada proveedor a «sin resultados», así que un
 * fallo del tercero es `null` —«no ha contestado»— y no una excepción que tirase
 * el guardado de la ficha.
 */

import { type SymbolCandidate, searchSymbols } from "@worthline/pricing";

export type SymbolSearcher = (
  query: string,
  instrument: "pension_plan",
) => Promise<SymbolCandidate[]>;

export async function resolvePlanSymbolFromDgs(
  code: string,
  search: SymbolSearcher = searchSymbols,
): Promise<string | null> {
  const trimmed = code.trim();

  if (!trimmed) return null;

  const candidates = await search(trimmed, "pension_plan");

  return candidates[0]?.symbol ?? null;
}
