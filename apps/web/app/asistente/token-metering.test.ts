import { describe, expect, it } from "vitest";

import { finishPartTokens, meterAssistantStream } from "./token-metering";

interface Part {
  type: string;
  totalUsage?: { totalTokens?: number };
}

function streamOf(parts: Part[]): ReadableStream<Part> {
  return new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("finishPartTokens", () => {
  it("reads the aggregate total from a finish part", () => {
    expect(finishPartTokens({ type: "finish", totalUsage: { totalTokens: 42 } })).toBe(
      42,
    );
  });

  it("is zero for non-finish parts and for a finish without a usable total", () => {
    expect(finishPartTokens({ type: "text-delta" })).toBe(0);
    expect(finishPartTokens({ type: "finish" })).toBe(0);
    expect(finishPartTokens({ type: "finish", totalUsage: { totalTokens: 0 } })).toBe(0);
  });
});

describe("meterAssistantStream", () => {
  it("re-emits every part unchanged and resolves the finish total", async () => {
    const { stream, totalTokens } = meterAssistantStream(
      streamOf([
        { type: "start" },
        { type: "text-delta" },
        { type: "finish", totalUsage: { totalTokens: 16 } },
      ]),
    );

    const parts = await drain(stream);
    expect(parts.map((p) => p.type)).toEqual(["start", "text-delta", "finish"]);
    expect(await totalTokens).toBe(16);
  });

  it("resolves zero when the stream carries no usable finish total", async () => {
    const { stream, totalTokens } = meterAssistantStream(
      streamOf([{ type: "start" }, { type: "text-delta" }]),
    );

    await drain(stream);
    expect(await totalTokens).toBe(0);
  });

  it("resolves the accumulated total when the consumer cancels early", async () => {
    const { stream, totalTokens } = meterAssistantStream(
      streamOf([{ type: "finish", totalUsage: { totalTokens: 9 } }, { type: "start" }]),
    );

    const reader = stream.getReader();
    await reader.read(); // pull the finish part, then abandon the rest
    await reader.cancel();

    expect(await totalTokens).toBe(9);
  });
});
