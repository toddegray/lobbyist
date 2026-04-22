/**
 * Smoke tests for type helpers (windowKey, fmtUsd, fmtPct).
 */

import { describe, expect, test } from "bun:test";
import { fmtPct, fmtUsd, windowKey } from "../src/core/types.ts";

describe("windowKey", () => {
  test("all quarters", () => {
    expect(windowKey({ year_start: 2020, year_end: 2024 })).toBe("2020-2024-all");
  });
  test("single quarter", () => {
    expect(windowKey({ year_start: 2023, year_end: 2023, quarter: 3 })).toBe("2023-2023-Q3");
  });
});

describe("fmtUsd", () => {
  test("default no decimals", () => {
    expect(fmtUsd(1234567)).toBe("$1,234,567");
    expect(fmtUsd(0)).toBe("$0");
  });
  test("negative amounts", () => {
    expect(fmtUsd(-500)).toBe("-$500");
  });
  test("with decimals", () => {
    expect(fmtUsd(1234.5, { decimals: 2 })).toBe("$1,234.50");
  });
});

describe("fmtPct", () => {
  test("default one decimal", () => {
    expect(fmtPct(0.5)).toBe("50.0%");
    expect(fmtPct(0.1234)).toBe("12.3%");
  });
  test("negative", () => {
    expect(fmtPct(-0.05)).toBe("-5.0%");
  });
});
