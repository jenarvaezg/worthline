import { describe, expect, it } from "vitest";

import { createInMemoryStore } from "@worthline/db";

import { seedPersona } from "@web/demo/seed-persona";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";

import { AgentViewHttpError } from "./contract";
import {
  publicIdMap,
  requirePublicId,
  resolveInternalHoldingId,
  resolveInternalScopeId,
} from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

const AS_OF = "2026-06-19";

describe("agent-view scope-resolution", () => {
  it("maps public IDs by entity type and resolves scope/holding lookups", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, FAMILIA_SPEC, AS_OF);

    const publicIds = await store.agentView.readPublicIds();
    const scopes = await listAgentViewScopes(store.agentView);
    const scope = scopes.find((candidate) => candidate.isDefault) ?? scopes[0];
    if (!scope) throw new Error("seed has no scope");

    const scopeById = publicIdMap(publicIds, "scope");
    expect(scopeById.get("household")).toBe(scope.id);
    expect(requirePublicId(scopeById, "household")).toBe(scope.id);

    const internalScopeId = await resolveInternalScopeId(store.agentView, scope.id);
    expect(internalScopeId).toBe("household");

    const [asset] = await store.agentView.readAssets();
    if (!asset) throw new Error("seed has no asset holding");

    const holdingById = publicIdMap(publicIds, "holding");
    const holdingPublicId = requirePublicId(holdingById, asset.id);
    const internalHoldingId = await resolveInternalHoldingId(
      store.agentView,
      holdingPublicId,
    );
    expect(internalHoldingId).toBe(asset.id);
  }, 15_000);

  it("returns 404 for unknown public scope and holding IDs", async () => {
    const store = await createInMemoryStore();
    await seedPersona(store, FAMILIA_SPEC, AS_OF);

    await expect(
      resolveInternalScopeId(store.agentView, "wl_scp_missing"),
    ).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });

    await expect(
      resolveInternalHoldingId(store.agentView, "wl_hld_missing"),
    ).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  }, 15_000);

  it("surfaces an incomplete registry as a controlled 500", () => {
    expect(() => requirePublicId(new Map(), "household")).toThrow(AgentViewHttpError);
    try {
      requirePublicId(new Map(), "household");
    } catch (error) {
      expect(error).toMatchObject({ status: 500, code: "internal_error" });
    }
  });
});
