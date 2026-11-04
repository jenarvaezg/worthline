import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { readStoredJson } from "./stored-json";

const schema = z.object({ deviceId: z.string().min(1) });

describe("readStoredJson: a stored blob, validated at the boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a blob that fits its schema comes back typed, with no log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readStoredJson(schema, '{"deviceId":"device-7"}', "credenciales")).toEqual({
      deviceId: "device-7",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("nothing stored is not corruption: null, with no log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readStoredJson(schema, null, "credenciales")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("a blob that is not JSON reads as absent and leaves a log that never carries it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readStoredJson(schema, '{"password":"s3cr3t-913', "credenciales")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain("credenciales");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cr3t-913");
  });

  test("JSON of another shape reads as absent and logs which field failed, not its value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      readStoredJson(schema, '{"deviceId":4471,"password":"s3cr3t-913"}', "credenciales"),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("deviceId");
    expect(logged).not.toContain("s3cr3t-913");
    expect(logged).not.toContain("4471");
  });
});
