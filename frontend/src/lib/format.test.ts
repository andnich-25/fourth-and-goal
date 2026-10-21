import { describe, expect, it } from "vitest";
import { americanToProb, decimalToProb, kickoff, num, pct } from "./format";

describe("format", () => {
  it("converts American and decimal odds to implied probability", () => {
    expect(americanToProb("+150")).toBeCloseTo(0.4);
    expect(americanToProb("-120")).toBeCloseTo(120 / 220);
    expect(americanToProb("2.50")).toBeCloseTo(0.4);
    expect(americanToProb("+50")).toBeNull();
    expect(decimalToProb("1.0")).toBeNull();
  });
  it("never renders missing values as zero", () => {
    expect(pct(null)).toBe("—");
    expect(num(undefined)).toBe("—");
    expect(pct(0)).toBe("0%");
  });
  it("shows Eastern kickoffs in Central time", () => {
    expect(kickoff("2026-10-25", "13:00")).toMatch(/12:00\s?PM CDT/);
  });
});
