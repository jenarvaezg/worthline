/**
 * Who a lane's refusal was WRITTEN for (#1752).
 *
 * When a `propose_*` lane says no, its answer carries a Spanish sentence — and those
 * sentences have two very different addressees. Some route the PERSON: «no he visto la
 * fecha. Dime el día («hoy», «ayer» o 12/08/2026)». Others scold the MODEL for a figure
 * that does not come from the source: «tu mensaje no dice las participaciones, y tú
 * pasas 6».
 *
 * Until now the difference was invisible to the app, so the fabricated-proposal note
 * (#1468) had to treat them all as unprintable and say only «tendrás que volver a
 * pedírselo, quizá de otra forma». Its own comment named the missing piece — *«distinguir
 * esos de los que rutean al usuario es un trabajo aparte»* — and this module is that
 * piece. Jose's case is the cost of not having it: the refusal held the exact words that
 * unblocked him («no sé cuál es el importe: escríbeme sólo ése») and they were thrown
 * away, while the model narrated success on top.
 *
 * THE RULE, and it is the only one that scales: **the audience is declared by whoever
 * writes the sentence**, on the refusal itself. Not inferred here by reading the prose —
 * a heuristic over Spanish second person would be one more thing to get wrong on the
 * write path, and it would silently reclassify every sentence anyone rewords.
 *
 * A refusal that declares NO audience prints nothing, exactly as today. That is what
 * lets the lanes adopt this one at a time: silence is the safe default, and the note it
 * leaves standing is the note that already shipped.
 */

/** Who the sentence is addressed to. */
export type RefusalAudience = "model" | "user";

/** A lane's refusal, as the tool answers it. */
export interface ProposalRefusal {
  audience: RefusalAudience;
  error: string;
  message: string;
}

/**
 * A refusal whose sentence is written FOR THE PERSON: it says what to type, what to
 * check, or where to go. These are the ones the screen may quote.
 */
export function userRefusal(error: string, message: string): ProposalRefusal {
  return { audience: "user", error, message };
}

/**
 * A refusal written AT THE MODEL: «y tú pasas 6 participaciones», «lee la cartera y pasa
 * el identificador». True, useful, and confusing on screen — it makes the app look like
 * it is arguing with someone the user cannot see.
 */
export function modelRefusal(error: string, message: string): ProposalRefusal {
  return { audience: "model", error, message };
}

/** Is this a `{ audience, error, message }` a lane answered with? */
function isRefusal(output: unknown): output is ProposalRefusal {
  if (typeof output !== "object" || output === null) return false;
  const { audience, message } = output as Partial<ProposalRefusal>;
  return (
    (audience === "user" || audience === "model") &&
    typeof message === "string" &&
    message.trim().length > 0
  );
}

/**
 * The sentence this tool answer has for the USER, or `null` when it has none — because
 * the answer is a proposal, because the refusal was written at the model, or because the
 * lane has not declared an audience yet.
 */
export function userFacingRefusal(output: unknown): string | null {
  if (!isRefusal(output)) return null;
  return output.audience === "user" ? output.message.trim() : null;
}
