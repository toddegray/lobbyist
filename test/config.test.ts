/**
 * Smoke tests for the config builder. No network, no stdin.
 */

import { describe, expect, test } from "bun:test";
import { buildConfig } from "../src/core/config.ts";

describe("buildConfig", () => {
  test("accepts a minimal valid input", () => {
    const cfg = buildConfig({
      operator_name: "Todd Gray",
      operator_email: "you@example.com",
      lda_api_key: "abcdefghij1234567890",
    });
    expect(cfg.version).toBe(1);
    expect(cfg.operator.email).toBe("you@example.com");
    expect(cfg.lda_api_key).toBe("abcdefghij1234567890");
    expect(cfg.default_year_start).toBe(2020);
    expect(cfg.default_year_end).toBe(2024);
    expect(cfg.lda_rate_limit_rps).toBe(1);
    expect(cfg.openfec_api_key).toBeNull();
  });

  test("rejects a too-short LDA key", () => {
    expect(() =>
      buildConfig({
        operator_name: "x",
        operator_email: "x@x.com",
        lda_api_key: "tooshort",
      }),
    ).toThrow();
  });

  test("rejects a malformed email", () => {
    expect(() =>
      buildConfig({
        operator_name: "x",
        operator_email: "not-an-email",
        lda_api_key: "abcdefghij1234567890",
      }),
    ).toThrow();
  });

  test("year range defaults + overrides", () => {
    const cfg = buildConfig({
      operator_name: "x",
      operator_email: "x@x.com",
      lda_api_key: "abcdefghij1234567890",
      default_year_start: 2015,
      default_year_end: 2023,
    });
    expect(cfg.default_year_start).toBe(2015);
    expect(cfg.default_year_end).toBe(2023);
  });
});
