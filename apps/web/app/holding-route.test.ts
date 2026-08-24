import type { ExportedPublicId } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  holdingBoardHref,
  holdingCobrosHref,
  holdingDetailHref,
  holdingOperationsHref,
  holdingPublicIdIndex,
  holdingPublicIdOf,
  isPublicHoldingId,
  resolveHoldingRoute,
} from "./holding-route";

const rows: ExportedPublicId[] = [
  { entityId: "asset_fondo", entityType: "holding", publicId: "wl_hld_aaaa" },
  { entityId: "liability_hipoteca", entityType: "holding", publicId: "wl_hld_bbbb" },
  { entityId: "household", entityType: "scope", publicId: "wl_scp_cccc" },
  { entityId: "member_jose", entityType: "member", publicId: "wl_mbr_dddd" },
];

const index = holdingPublicIdIndex(rows);

describe("holding public id vocabulary", () => {
  test("recognises the agent-view public holding shape and nothing else", () => {
    expect(isPublicHoldingId("wl_hld_aaaa")).toBe(true);
    expect(isPublicHoldingId("asset_fondo")).toBe(false);
    expect(isPublicHoldingId("liability_hipoteca")).toBe(false);
    // A scope/member public id is not a holding id — the prefix is the whole test.
    expect(isPublicHoldingId("wl_scp_cccc")).toBe(false);
  });

  test("builds the ficha and board hrefs from the public id", () => {
    expect(holdingDetailHref("wl_hld_aaaa")).toBe("/patrimonio/wl_hld_aaaa/editar");
    expect(holdingBoardHref("wl_hld_aaaa")).toBe("/patrimonio#wl_hld_aaaa");
  });

  test("the operations deep-link unfolds the advanced block, not just the fragment", () => {
    expect(holdingOperationsHref("wl_hld_aaaa")).toBe(
      "/patrimonio/wl_hld_aaaa/editar?abrir=operaciones#operaciones",
    );
  });

  test("the cobros deep-link unfolds the advanced block, not just the fragment", () => {
    expect(holdingCobrosHref("wl_hld_aaaa")).toBe(
      "/patrimonio/wl_hld_aaaa/editar?abrir=cobros#cobros",
    );
  });
});

describe("holdingPublicIdIndex", () => {
  test("indexes only the holding rows, in both directions", () => {
    expect(index.publicByInternal.get("asset_fondo")).toBe("wl_hld_aaaa");
    expect(index.internalByPublic.get("wl_hld_bbbb")).toBe("liability_hipoteca");
    // Scopes and members share the registry table but not this index.
    expect(index.publicByInternal.has("household")).toBe(false);
    expect(index.internalByPublic.has("wl_mbr_dddd")).toBe(false);
  });
});

describe("resolveHoldingRoute", () => {
  test("resolves a public route id to its internal storage id", () => {
    expect(resolveHoldingRoute("wl_hld_aaaa", index)).toBe("asset_fondo");
    expect(resolveHoldingRoute("wl_hld_bbbb", index)).toBe("liability_hipoteca");
  });

  test("a public id with no registry row is a 404, never a fallthrough", () => {
    expect(resolveHoldingRoute("wl_hld_doesnotexist", index)).toBeNull();
  });

  test("an internal id is not a route — the second vocabulary is retired (#1318)", () => {
    // Deliberately NOT a redirect: an alias would keep both vocabularies alive,
    // which is the defect. Every producer of a holding URL emits the public id.
    expect(resolveHoldingRoute("asset_fondo", index)).toBeNull();
    expect(resolveHoldingRoute("liability_hipoteca", index)).toBeNull();
  });
});

describe("holdingPublicIdOf", () => {
  test("returns the registered public id", () => {
    expect(holdingPublicIdOf(index, "asset_fondo")).toBe("wl_hld_aaaa");
  });

  test("a registry gap yields nothing — never the internal id as a stand-in", () => {
    // Callers drop the link or the scroll anchor. Handing back `asset_sin_registro`
    // would put the retired vocabulary back in a URL, which is the one outcome
    // worse than no link at all.
    expect(holdingPublicIdOf(index, "asset_sin_registro")).toBeUndefined();
  });
});
