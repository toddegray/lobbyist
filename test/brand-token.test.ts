/**
 * Tests for the brandToken helper in committee-influence.
 *
 * brandToken picks the first distinctive word from a normalized entity
 * name, used as a fallback when the full normalized name returns zero
 * FEC ScheduleA receipts. Over-aggressive matching (returning "UNITED"
 * for "UNITED AIRLINES") would flood results with false positives;
 * under-aggressive (returning nothing) forfeits real matches.
 */

import { describe, expect, test } from "bun:test";
import { brandToken } from "../src/skills/committee-influence.ts";
import { normalizeEntityName } from "../src/db/repos.ts";

describe("brandToken", () => {
  test("skips legal suffixes via normalize and returns the first brand word", () => {
    expect(brandToken(normalizeEntityName("Pfizer Inc."))).toBe("PFIZER");
    expect(brandToken(normalizeEntityName("The Boeing Company"))).toBe("BOEING");
    expect(brandToken(normalizeEntityName("GENENTECH INC"))).toBe("GENENTECH");
  });

  test("skips generic qualifiers", () => {
    expect(brandToken(normalizeEntityName("National Football League"))).toBe("FOOTBALL");
    expect(brandToken(normalizeEntityName("American Heart Association"))).toBe("HEART");
    expect(brandToken(normalizeEntityName("United Airlines"))).toBe("AIRLINES");
  });

  test("skips tokens shorter than 4 chars", () => {
    // "F HOFFMANN LA ROCHE" — "F" too short, "LA" too short, lands on HOFFMANN
    expect(brandToken("F HOFFMANN LA ROCHE")).toBe("HOFFMANN");
  });

  test("returns first token when all are distinctive", () => {
    expect(brandToken("KAISER FOUNDATION HEALTH PLAN")).toBe("KAISER");
  });

  test("returns null for an all-generic name", () => {
    expect(brandToken("NATIONAL GLOBAL INTERNATIONAL")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(brandToken("")).toBeNull();
    expect(brandToken("   ")).toBeNull();
  });
});
