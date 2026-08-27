/**
 * Reading a claim out of the assistant's own prose, shared by the two ceremony
 * guards (#1262/#1468 for proposals, #1525 for the maintainer alert).
 *
 * It exists because the second guard would otherwise have copied the first one's
 * sentence splitting and its negation rule, and those are not incidental details:
 * the splitting is what stops «He creado el holding» in one sentence and «¿quieres
 * que prepare una propuesta?» in the next from reading as a fabrication, and the
 * negation guard is what stops a guard from feeding itself — the history note
 * provokes «no he registrado ninguna incidencia», which without it trips the very
 * check that wrote the note, on every turn, for the rest of the conversation.
 *
 * Two copies of that would drift apart the first time either is widened, and the
 * drift would be silent: both failure modes only show up in a real conversation.
 */

/**
 * A claim the model NEGATES is not a claim. Read over the text BEFORE the match,
 * so «no he preparado la propuesta» is exempt while «he preparado la propuesta,
 * pero no la he aplicado» is not.
 */
export const NEGATION = /\b(no|nunca|tampoco)\b/i;

/**
 * The OTHER «tarjeta» — a means of payment a workspace really holds, `credit_card` in
 * the book. «He actualizado el saldo de tu tarjeta de crédito» is a sentence about the
 * user's money, not about the ceremony, and since #1468 put «tarjeta» in the vocabulary
 * it would otherwise read as a fabricated proposal on one of the most ordinary turns
 * there is. Shared with the eval grader that had to make the same distinction for the
 * same word (`commentsOnTheInterface`), so the two readings cannot drift.
 */
export const PAYMENT_CARD_READING = /tarjetas?\s+de\s+(cr[ée]dito|d[ée]bito)/giu;

/**
 * Splits into sentences so a claim and the ceremony's noun must occur TOGETHER.
 *
 * Two maskings first. Decimals, because a figure like «5.511,96» would otherwise cut
 * the very sentence this exists to read. And the payment card, because it is the one
 * innocent meaning the ceremony's vocabulary has (#1468).
 */
export function sentences(text: string): string[] {
  return text
    .replace(/(\d)\.(\d)/g, "$1·$2")
    .replace(PAYMENT_CARD_READING, "medio de pago")
    .split(/[.!?\n]+/);
}

/** Does this sentence assert one of `patterns`, without negating it first? */
export function assertsAny(sentence: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => {
    const match = pattern.exec(sentence);
    return match !== null && !NEGATION.test(sentence.slice(0, match.index));
  });
}
