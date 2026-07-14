import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import AssistantAttachmentControl from "./assistant-attachment-control";

describe("AssistantAttachmentControl", () => {
  test("offers an accessible CSV/XLSX picker", () => {
    const html = renderToStaticMarkup(
      <AssistantAttachmentControl
        disabled={false}
        file={null}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(html).toContain('type="file"');
    expect(html).toContain('id="assistant-positions-file"');
    expect(html).toContain('for="assistant-positions-file"');
    expect(html).toContain(".csv");
    expect(html).toContain(".xlsx");
  });

  test("announces the selected attachment and lets the user remove it", () => {
    const file = new File(["ticker;nombre"], "mi cartera.csv", { type: "text/csv" });
    const html = renderToStaticMarkup(
      <AssistantAttachmentControl
        disabled={false}
        file={file}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(html).toContain("mi cartera.csv");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Quitar mi cartera.csv"');
  });
});
