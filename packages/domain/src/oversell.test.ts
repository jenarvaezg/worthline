import { describe, expect, test } from "vitest";

import { classifyOversellExcess, oversellConfirmMessage } from "./oversell";

describe("classifyOversellExcess", () => {
  test("32 against 31.999 is broker dust, not a fat-finger", () => {
    expect(classifyOversellExcess("31.999", "32")).toBe("dust");
  });

  test("320 against 31.999 is a fat-finger", () => {
    expect(classifyOversellExcess("31.999", "320")).toBe("fat_finger");
  });

  test("held at 0 is always a fat-finger", () => {
    expect(classifyOversellExcess("0", "1")).toBe("fat_finger");
    expect(classifyOversellExcess("0", "0.001")).toBe("fat_finger");
  });

  test("an excess of 1 unit still counts as dust", () => {
    expect(classifyOversellExcess("10", "11")).toBe("dust");
  });

  test("an excess just over 1 unit is a fat-finger unless it is ≤ 1% of held", () => {
    expect(classifyOversellExcess("10", "11.1")).toBe("fat_finger");
    expect(classifyOversellExcess("200", "202")).toBe("dust");
  });
});

describe("oversellConfirmMessage", () => {
  test("dust copy names the broker rounding", () => {
    expect(oversellConfirmMessage("31.999", "32")).toBe(
      "Tienes 31,999; vas a vender 32. Si es el redondeo del bróker, confirma. Si no, corrige las unidades.",
    );
  });

  test("fat-finger copy names the mistype", () => {
    expect(oversellConfirmMessage("31.999", "320")).toBe(
      "Tienes 31,999; vas a vender 320. Eso supera con mucho la posición. Si no es un dedazo, confirma.",
    );
  });
});
