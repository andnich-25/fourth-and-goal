import { describe, expect, it } from "vitest";
import { easternToUtc, staticKey } from "./static";

describe("static site helpers", () => {
  it("builds the same file keys as engine/export_static.py", () => {
    expect(staticKey("/health")).toBe("health/index.json");
    expect(staticKey("/rankings", { season: 2026, week: 7, page: 2 })).toBe("rankings/season-2026_week-7.json");
    expect(staticKey("/defenses", { week: 7, season: 2026, window: undefined })).toBe("defenses/season-2026_week-7.json");
    expect(staticKey("/defenses/GB", { season: 2026, week: 7, window: 6 })).toBe("defenses/GB/season-2026_week-7_window-6.json");
    expect(staticKey("/backtest/picks", { model: "fg-logit-1" })).toBe("backtest/picks/model-fg-logit-1.json");
  });
  it("converts Eastern kickoff times to UTC across daylight saving", () => {
    expect(easternToUtc("2026-10-22", "20:15")).toBe("2026-10-23T00:15:00.000Z");
    expect(easternToUtc("2026-11-08", "13:00")).toBe("2026-11-08T18:00:00.000Z");
    expect(easternToUtc(null, "13:00")).toBeNull();
  });
});

import { pOver } from "./props";

describe("prop over chance", () => {
  it("reads a negative binomial CDF at a half line", () => {
    const d = { type: "nbinom" as const, n: 5, p: 0.5, cdf: [0.1, 0.3, 0.6, 0.85, 1], platt: [1, 0] as [number, number] };
    expect(pOver(d, 1.5)).toBeCloseTo(0.7, 6);
    expect(pOver(d, 9.5)).toBeCloseTo(0.005, 6);
  });
  it("interpolates the quantile CDF and applies recalibration", () => {
    const q = Array.from({ length: 99 }, (_, i) => i + 1); // quantile k% = k
    const d = { type: "quantiles" as const, q, platt: [1, 0] as [number, number] };
    expect(pOver(d, 50.5)).toBeCloseTo(0.495, 6);
    const shrunk = pOver({ ...d, platt: [0.5, 0] }, 80.5);
    expect(shrunk).toBeGreaterThan(0.195);
    expect(shrunk).toBeLessThan(0.5);
  });
});
