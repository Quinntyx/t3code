import { describe, expect, it } from "vite-plus/test";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";

describe("formatContextWindowCost", () => {
  it("keeps cents for a normal amount", () => {
    expect(formatContextWindowCost({ amount: 1.84, currency: "USD" })).toBe("USD 1.84");
  });

  it("keeps four digits for a fraction of a cent, instead of rounding it away", () => {
    expect(formatContextWindowCost({ amount: 0.0042, currency: "USD" })).toBe("USD 0.0042");
  });

  it("does not widen a zero cost", () => {
    expect(formatContextWindowCost({ amount: 0, currency: "USD" })).toBe("USD 0.00");
  });
});
