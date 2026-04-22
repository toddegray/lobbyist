/**
 * Smoke tests for the DB layer. Isolated temp directory per test so we
 * don't splatter fixtures across the user's real data_dir.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbClient } from "../src/db/engine.ts";
import {
  addAnnotation,
  entityKey,
  getEntity,
  listAnnotations,
  lookupEntityByName,
  normalizeEntityName,
  saveBrief,
  loadLatestBrief,
  upsertEntity,
  upsertEntityAlias,
} from "../src/db/repos.ts";
import type { Brief } from "../src/core/types.ts";

let tmp: string;
let db: DbClient;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lobbyist-test-"));
  db = await openDb({ dataDir: tmp });
});

afterEach(async () => {
  await db.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("normalizeEntityName", () => {
  test("strips punctuation, case, and legal suffixes", () => {
    expect(normalizeEntityName("Pfizer Inc.")).toBe("PFIZER");
    expect(normalizeEntityName("Pfizer, Inc.")).toBe("PFIZER");
    expect(normalizeEntityName("PFIZER INC")).toBe("PFIZER");
    expect(normalizeEntityName("Pfizer Incorporated")).toBe("PFIZER");
  });
  test("leaves naked names alone", () => {
    expect(normalizeEntityName("Google")).toBe("GOOGLE");
    expect(normalizeEntityName("  Open  Society  ")).toBe("OPEN SOCIETY");
  });
  test("handles nested suffixes (e.g. 'Foo Inc LLC')", () => {
    expect(normalizeEntityName("Foo Inc LLC")).toBe("FOO");
  });
});

describe("entities + aliases", () => {
  test("upsertEntity then getEntity roundtrip", async () => {
    await upsertEntity(db, {
      kind: "client",
      id: "12345",
      display: "Pfizer Inc",
      external_id: "12345",
      metadata: { state: "NY" },
    });
    const e = await getEntity(db, entityKey("client", "12345"));
    expect(e).not.toBeNull();
    expect(e!.display).toBe("Pfizer Inc");
    expect(e!.metadata).toEqual({ state: "NY" });
  });

  test("aliases map name-variants to the same entity", async () => {
    await upsertEntity(db, {
      kind: "client",
      id: "12345",
      display: "Pfizer Inc",
      external_id: "12345",
    });
    const eid = entityKey("client", "12345");
    await upsertEntityAlias(db, { entity_id: eid, raw: "Pfizer, Inc.", source: "lda" });
    await upsertEntityAlias(db, { entity_id: eid, raw: "PFIZER INC", source: "lda" });

    // All three variants resolve to the same stored entity.
    const a = await lookupEntityByName(db, "Pfizer Inc.");
    const b = await lookupEntityByName(db, "pfizer, inc");
    const c = await lookupEntityByName(db, "pfizer");
    expect(a?.id).toBe("12345");
    expect(b?.id).toBe("12345");
    expect(c?.id).toBe("12345");
  });

  test("lookupEntityByName respects kind filter", async () => {
    await upsertEntity(db, { kind: "client", id: "1", display: "Acme" });
    await upsertEntity(db, { kind: "registrant", id: "2", display: "Acme" });
    await upsertEntityAlias(db, {
      entity_id: entityKey("client", "1"),
      raw: "Acme",
      source: "lda",
    });
    await upsertEntityAlias(db, {
      entity_id: entityKey("registrant", "2"),
      raw: "Acme",
      source: "lda",
    });
    const asClient = await lookupEntityByName(db, "Acme", "client");
    const asRegistrant = await lookupEntityByName(db, "Acme", "registrant");
    expect(asClient?.id).toBe("1");
    expect(asRegistrant?.id).toBe("2");
  });
});

describe("briefs + annotations", () => {
  test("saveBrief / loadLatestBrief roundtrip", async () => {
    const brief: Brief<{ total: number }> = {
      skill: "entity-profile",
      schema_version: 1,
      entity: { kind: "client", id: "12345", display: "Pfizer Inc" },
      window: { year_start: 2020, year_end: 2024 },
      generated_at: "2024-01-15T00:00:00.000Z",
      data: { total: 42 },
      citations: [],
      markdown: "# hello",
    };
    await upsertEntity(db, { kind: "client", id: "12345", display: "Pfizer Inc" });
    await saveBrief(db, brief);
    const loaded = await loadLatestBrief<{ total: number }>(db, {
      entity_id: entityKey("client", "12345"),
      skill: "entity-profile",
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.data.total).toBe(42);
    expect(loaded!.markdown).toBe("# hello");
  });

  test("re-save replaces the existing (entity, skill, window) row", async () => {
    const mkBrief = (total: number): Brief<{ total: number }> => ({
      skill: "entity-profile",
      schema_version: 1,
      entity: { kind: "client", id: "12345", display: "Pfizer Inc" },
      window: { year_start: 2020, year_end: 2024 },
      generated_at: new Date().toISOString(),
      data: { total },
      citations: [],
      markdown: `total=${total}`,
    });
    await upsertEntity(db, { kind: "client", id: "12345", display: "Pfizer Inc" });
    await saveBrief(db, mkBrief(1));
    await saveBrief(db, mkBrief(2));
    const loaded = await loadLatestBrief<{ total: number }>(db, {
      entity_id: entityKey("client", "12345"),
      skill: "entity-profile",
    });
    expect(loaded!.data.total).toBe(2);
  });

  test("annotations append in order", async () => {
    await upsertEntity(db, { kind: "client", id: "12345", display: "Pfizer Inc" });
    const eid = entityKey("client", "12345");
    await addAnnotation(db, eid, "first note");
    await addAnnotation(db, eid, "second note");
    const notes = await listAnnotations(db, eid);
    expect(notes.length).toBe(2);
    expect(notes[0]!.note).toBe("first note");
    expect(notes[1]!.note).toBe("second note");
  });
});
