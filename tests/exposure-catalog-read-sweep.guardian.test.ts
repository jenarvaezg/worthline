import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Anti-regression sweep for PRD #711 S3 (ADR 0058): once the global catalog is
 * the source of truth, no look-through / display / agent-view surface may read
 * exposure profiles from the per-workspace store again. The remaining local
 * reads are exclusively the write/confirm validation path (retired in S5) — none
 * of the surfaces below may reintroduce a `store.exposureProfiles.read*` or an
 * `agentView.readExposureProfiles` call.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read surfaces that were repointed to the injected catalog port. */
const REROUTED_READ_SURFACES = [
  "apps/web/app/agent-view/financial-context.ts",
  "apps/web/app/agent-view/holding-detail.ts",
  "apps/web/app/agent-view/contribution-plan-context.ts",
  "apps/web/app/agent-view/returns.ts",
  "apps/web/app/(workspace)/patrimonio/page.tsx",
  "apps/web/app/(workspace)/objetivos/page.tsx",
  "apps/web/app/(workspace)/patrimonio/[id]/editar/page.tsx",
];

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("exposure catalog read sweep (#711 S3)", () => {
  test.each(
    REROUTED_READ_SURFACES,
  )("%s no longer reads exposure profiles from the workspace store", (relativePath) => {
    const code = source(relativePath);
    expect(code).not.toContain("exposureProfiles.readExposureProfile");
    expect(code).not.toContain(".readExposureProfiles(");
  });

  test("the agent-view read port no longer exposes readExposureProfiles", () => {
    const code = source("packages/db/src/agent-view-read-store.ts");
    expect(code).not.toContain("readExposureProfiles");
  });

  test("index.ts no longer wires readExposureProfiles into the agent view", () => {
    const code = source("packages/db/src/index.ts");
    expect(code).not.toContain("readExposureProfiles: exposureProfileStore");
  });
});
