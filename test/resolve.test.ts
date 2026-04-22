/**
 * Entity-resolution smoke tests. These exercise the cache-first lookup
 * and alias graph, plus the fuzzy matcher that surfaces the best LDA hit
 * when the user's spelling doesn't match verbatim.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbClient } from "../src/db/engine.ts";
import { entityKey, lookupEntityByName, upsertEntity, upsertEntityAlias } from "../src/db/repos.ts";

let tmp: string;
let db: DbClient;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lobbyist-resolve-"));
  db = await openDb({ dataDir: tmp });
});
afterEach(async () => {
  await db.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("alias lookups survive punctuation + legal-suffix variants", () => {
  test("Pfizer variants all resolve to the same canonical entity", async () => {
    await upsertEntity(db, {
      kind: "client",
      id: "500",
      display: "Pfizer Inc.",
      external_id: "500",
    });
    const eid = entityKey("client", "500");
    await upsertEntityAlias(db, { entity_id: eid, raw: "Pfizer Inc.", source: "lda" });

    for (const variant of ["Pfizer Inc.", "PFIZER INC", "pfizer, inc", "Pfizer", "pfizer incorporated"]) {
      const hit = await lookupEntityByName(db, variant);
      expect(hit?.id, `failed on variant "${variant}"`).toBe("500");
    }
  });

  test("confirmed alias beats unconfirmed alias on ties", async () => {
    await upsertEntity(db, { kind: "client", id: "1", display: "Generic Name" });
    await upsertEntity(db, { kind: "client", id: "2", display: "Generic Name Corp" });
    // Both normalize to "GENERIC NAME"
    await upsertEntityAlias(db, { entity_id: entityKey("client", "1"), raw: "Generic Name", source: "lda" });
    await upsertEntityAlias(db, {
      entity_id: entityKey("client", "2"),
      raw: "Generic Name Corp",
      source: "user",
      confirmed: true,
    });
    const hit = await lookupEntityByName(db, "generic name");
    expect(hit?.id).toBe("2"); // confirmed wins
  });
});
