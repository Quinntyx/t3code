import { describe, expect, it } from "vite-plus/test";

import { strongFontWeight } from "./markdownStrongWeight";

describe("strongFontWeight", () => {
  it("bolds Android fallback glyphs even when the bold family is not bold by weight", () => {
    expect(strongFontWeight(false, "android")).toBe("bold");
    expect(strongFontWeight(undefined, "android")).toBe("bold");
  });

  it("leaves iOS to the family's own weight unless it is bold by weight", () => {
    expect(strongFontWeight(false, "ios")).toBe("normal");
    expect(strongFontWeight(undefined, "ios")).toBe("normal");
    expect(strongFontWeight(true, "ios")).toBe("bold");
  });
});
