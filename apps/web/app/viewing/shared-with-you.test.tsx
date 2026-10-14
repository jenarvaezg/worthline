import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import SharedWithYou from "./shared-with-you";

const ANA = {
  createdAt: "2026-10-01 09:30:00",
  ownerEmail: "ana@example.com",
  workspaceId: "ws_ana",
};
const EVA = {
  createdAt: "2026-10-02 09:30:00",
  ownerEmail: "eva@example.com",
  workspaceId: "ws_eva",
};

describe("«Compartidos contigo» (#1844)", () => {
  test("lists each owner's email with a way into their workspace", () => {
    const markup = renderToStaticMarkup(<SharedWithYou workspaces={[ANA, EVA]} />);

    expect(markup).toContain("Compartidos contigo");
    expect(markup).toContain("ana@example.com");
    expect(markup).toContain("eva@example.com");
    expect(markup.match(/Ver su espacio/g)).toHaveLength(2);
  });

  test("entering is a real POST to /viewing carrying the workspace id — never a GET link", () => {
    const markup = renderToStaticMarkup(<SharedWithYou workspaces={[ANA]} />);

    expect(markup).toContain('action="/viewing"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain('name="workspaceId"');
    expect(markup).toContain('value="ws_ana"');
    expect(markup).not.toContain('href="/viewing');
  });

  test("renders nothing when nobody shared a workspace", () => {
    expect(renderToStaticMarkup(<SharedWithYou workspaces={[]} />)).toBe("");
  });
});
