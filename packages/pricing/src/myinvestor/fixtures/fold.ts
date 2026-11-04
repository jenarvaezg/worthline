/** Lower case without diacritics: `Lucía` and `LUCIA` fold to the same text. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
