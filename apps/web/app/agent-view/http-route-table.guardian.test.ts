import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * The agent-view HTTP transport is a TABLE, not 22 copies of one template
 * (#1695). Before the table it was possible — and had happened — to add a read
 * endpoint that parsed its params before its guard, or returned a raw envelope
 * with no `catch`. These are the two properties the table buys, pinned so a
 * future endpoint cannot quietly reintroduce the hand-rolled shape.
 */

function agentViewSource(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

describe("agent-view HTTP route table", () => {
  test("every exported read handler is a table entry, not a hand-written body", () => {
    const source = agentViewSource("./http.ts");
    const handlers = source.match(/^export const handle\w+ = defineAgentViewRoute\(/gm);
    const exportedConsts = source.match(/^export const handle\w+/gm);

    expect(handlers).not.toBeNull();
    expect(handlers!.length).toBeGreaterThanOrEqual(22);
    expect(exportedConsts!.length).toBe(handlers!.length);
  });

  test("no handler carries its own catch or envelope", () => {
    const source = agentViewSource("./http.ts");

    expect(source).not.toContain("catch (");
    expect(source).not.toContain("try {");
    expect(source).not.toContain("NextResponse");
  });

  test("the request guard has exactly one caller — the route factory", () => {
    const directory = new URL(".", import.meta.url);
    const callers = readdirSync(directory)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) =>
        /^import .*\bguardAgentViewRequest\b/m.test(agentViewSource(`./${file}`)),
      );

    expect(callers).toEqual(["http-route.ts"]);
  });
});
