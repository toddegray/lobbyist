/**
 * Tests for the ask window parser.
 */

import { describe, expect, test } from "bun:test";
import { parseWindow } from "../src/agents/ask-helpers.ts";

describe("parseWindow", () => {
  test("single year", () => {
    expect(parseWindow("2024", "x")).toEqual({ year_start: 2024, year_end: 2024 });
  });
  test("year-quarter", () => {
    expect(parseWindow("2024-Q3", "x")).toEqual({
      year_start: 2024,
      year_end: 2024,
      quarter: 3,
    });
  });
  test("year range", () => {
    expect(parseWindow("2020-2024", "x")).toEqual({ year_start: 2020, year_end: 2024 });
  });
  test("invalid", () => {
    expect(() => parseWindow("banana", "label")).toThrow();
  });
});
