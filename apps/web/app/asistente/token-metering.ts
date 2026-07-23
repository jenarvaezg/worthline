/**
 * The recording half of the token meter (PRD #1160 S3, #1163): a passthrough tap
 * over the assistant's full stream that reads the token total once the turn
 * finishes, without delaying a single byte to the client.
 *
 * Tokens are only known AFTER the model completes, which is after we have begun
 * streaming the response — so recording cannot block the reply. The tap watches
 * for the AI SDK `finish` part (which carries `totalUsage` aggregated across all
 * steps), and resolves {@link MeteredStream.totalTokens} when the stream closes
 * or is cancelled. The route schedules the control-plane write with `after()`,
 * so a finished turn is metered whether or not the client kept reading.
 *
 * Scope (#1163): this meters the assistant's own model turn — the recurring
 * cost. The eager attachment extractors (`extractPositionsFromImage`,
 * `extractBalanceSeriesFromPdf`, the spreadsheet dispatch) are separate model
 * calls whose usage is NOT counted here: their contract deliberately hands
 * callers a validated JSON result and never provider output, so surfacing their
 * token usage is its own change. The pre-call gate still degrades them honestly
 * (a spent budget blocks extraction before it runs); metering that one-shot
 * ingestion cost is a documented follow-up, not part of this slice.
 */

/** The AI SDK full-stream `finish` part shape we read — only the total we meter. */
interface MaybeFinishPart {
  type: string;
  totalUsage?: { totalTokens?: number | undefined };
}

/** The tokens a single stream part contributes: the finish part's aggregate total, else 0. */
export function finishPartTokens(part: MaybeFinishPart): number {
  if (part.type !== "finish") return 0;
  const total = part.totalUsage?.totalTokens;
  return typeof total === "number" && total > 0 ? total : 0;
}

export interface MeteredStream<Part> {
  /** The passthrough stream to hand to the client — every part re-emitted unchanged. */
  stream: ReadableStream<Part>;
  /**
   * The turn's total tokens, resolved once the stream ends (done or cancel).
   * Zero when no usage was seen (e.g. the client disconnected before finish).
   */
  totalTokens: Promise<number>;
}

/**
 * Wrap a full stream so its finish token total can be recorded after the fact.
 * Re-emits every part unchanged; accumulates finish-part tokens; resolves
 * `totalTokens` exactly once when the stream terminates.
 */
export function meterAssistantStream<Part extends MaybeFinishPart>(
  source: ReadableStream<Part>,
): MeteredStream<Part> {
  const reader = source.getReader();
  let spent = 0;
  let settle: (tokens: number) => void = () => undefined;
  const totalTokens = new Promise<number>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const resolveOnce = (): void => {
    if (settled) return;
    settled = true;
    settle(spent);
  };

  const stream = new ReadableStream<Part>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          resolveOnce();
          controller.close();
          return;
        }
        spent += finishPartTokens(value);
        controller.enqueue(value);
      } catch (error) {
        resolveOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      resolveOnce();
      await reader.cancel(reason);
    },
  });

  return { stream, totalTokens };
}
