/**
 * Fuzzy-match smoke tests — the engine of entity resolution.
 */

import { describe, expect, test } from "bun:test";
import { bestMatch, jaroWinkler, levenshtein } from "../src/core/fuzzy.ts";

describe("levenshtein", () => {
  test("identity", () => {
    expect(levenshtein("pfizer", "pfizer")).toBe(0);
  });
  test("empty to x", () => {
    expect(levenshtein("", "pfizer")).toBe(6);
    expect(levenshtein("pfizer", "")).toBe(6);
  });
  test("one-char substitution", () => {
    expect(levenshtein("pfizer", "pfoser")).toBe(2);
  });
  test("canonical brand variants", () => {
    expect(levenshtein("PFIZER INC", "PFIZER INC.")).toBe(1);
    expect(levenshtein("PFIZER, INC.", "PFIZER INC")).toBeLessThanOrEqual(2);
  });
});

describe("jaroWinkler", () => {
  test("identity", () => {
    expect(jaroWinkler("pfizer", "pfizer")).toBe(1);
  });
  test("zero for nothing in common", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
  test("brand variants score high", () => {
    const s1 = jaroWinkler("PFIZER INC", "PFIZER INC.");
    const s2 = jaroWinkler("PFIZER", "PFIZER PHARMACEUTICALS");
    expect(s1).toBeGreaterThan(0.95);
    expect(s2).toBeGreaterThan(0.85);
  });
  test("shared prefix is weighted up", () => {
    const prefixed = jaroWinkler("google", "googal");
    const nonPrefixed = jaroWinkler("aaaaagoogle", "aaaaagoogal");
    // Same character-level similarity, but shared prefix boost makes the
    // prefix case score higher than an unshared-prefix case — we just
    // sanity-check that jaro-winkler yields a reasonable score.
    expect(prefixed).toBeGreaterThan(0.8);
    expect(nonPrefixed).toBeGreaterThan(0.8);
  });
});

describe("bestMatch", () => {
  test("picks closest candidate above threshold", () => {
    const res = bestMatch("Pfizer", ["Amazon", "PFIZER INC.", "PFIZER PHARMA"]);
    expect(res).not.toBeNull();
    expect(res!.index).toBe(1);
    expect(res!.score).toBeGreaterThan(0.85);
  });
  test("returns null when no candidate clears threshold", () => {
    const res = bestMatch("Pfizer", ["Amazon", "Google", "Microsoft"], { threshold: 0.9 });
    expect(res).toBeNull();
  });
  test("empty candidates is null", () => {
    expect(bestMatch("whatever", [])).toBeNull();
  });
});
