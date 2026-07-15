import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorthlineStore, type WorthlineStore } from "@worthline/db";

export function catchRedirect(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      throw new Error("Expected redirect but action returned normally");
    },
    (err: unknown) => {
      if (err instanceof Error && (err.message === "NEXT_REDIRECT" || "digest" in err)) {
        const digest = (err as { digest?: string }).digest ?? "";
        const parts = digest.split(";");
        return parts[2] ?? digest;
      }
      throw err;
    },
  );
}

export function fd(fields: Record<string, string>, currentUrl = "/patrimonio"): FormData {
  const form = new FormData();
  form.set("currentUrl", currentUrl);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

export function errorMessageOf(url: string): string {
  return new URL(url, "http://worthline.local").searchParams.get("error") ?? "";
}

const tempDirs: string[] = [];

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

export function createFileBackedStore(
  prefix = "worthline-test-",
): Promise<WorthlineStore> {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dataDir);

  return createWorthlineStore({
    databasePath: join(dataDir, "worthline.sqlite"),
  });
}

export function tempDatabasePath(prefix = "worthline-test-"): string {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dataDir);

  return join(dataDir, "worthline.sqlite");
}
