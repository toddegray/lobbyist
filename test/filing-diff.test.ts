/**
 * Smoke test for filing-diff's pure diff computation.
 *
 * We bypass the skill's client-resolution + API fetch layer and drive the
 * internal aggregator with synthetic filings. The skill itself is
 * network-driven, but the diff math is pure and tested here.
 *
 * Rather than exposing an internal function, we cover this end-to-end by
 * spinning up a temp db, stubbing the LDA client with a fake that returns
 * our fixtures, and asserting on the resulting brief.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbClient } from "../src/db/engine.ts";
import { upsertFilingsBatch } from "../src/db/repos.ts";
import { runFilingDiff } from "../src/skills/filing-diff.ts";
import type { LdaClient } from "../src/core/lda-client.ts";
import type { Filing } from "../src/core/lda-endpoints.ts";
import { mkFiling } from "./_fixtures.ts";

let tmp: string;
let db: DbClient;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lobbyist-filing-diff-"));
  db = await openDb({ dataDir: tmp });
});
afterEach(async () => {
  await db.close();
  await rm(tmp, { recursive: true, force: true });
});

// Fake LdaClient: returns fixtures via paginate, filtering by filing_year
// to match the real LDA API (which has no range filter — skills loop per-year).
class FakeLdaClient {
  constructor(public fixtures: Filing[] = []) {}
  async get(): Promise<any> {
    throw new Error("FakeLdaClient.get not expected in filing-diff test path");
  }
  async paginate(_path: string, query: Record<string, unknown>): Promise<Filing[]> {
    if (query && query.filing_year !== undefined) {
      const y = Number(query.filing_year);
      return this.fixtures.filter((f) => f.filing_year === y);
    }
    return this.fixtures;
  }
}

describe("filing-diff", () => {
  test("surfaces added issues, new lobbyists, and spend delta", async () => {
    const fromFilings: Filing[] = [
      mkFiling({
        uuid: "d1",
        year: 2020,
        quarter: 1,
        client_id: 777,
        client_name: "Acme Corp",
        registrant_id: 900,
        registrant_name: "FirmOne",
        income: "50000.00",
        issues: [
          {
            code: "TAX",
            display: "Taxation",
            lobbyists: [{ id: 10, first_name: "Alice", last_name: "Smith" }],
            govt_entities: ["SENATE"],
          },
        ],
      }),
    ];
    const toFilings: Filing[] = [
      mkFiling({
        uuid: "d2",
        year: 2024,
        quarter: 1,
        client_id: 777,
        client_name: "Acme Corp",
        registrant_id: 900,
        registrant_name: "FirmOne",
        income: "120000.00",
        issues: [
          {
            code: "TAX",
            display: "Taxation",
            lobbyists: [{ id: 10, first_name: "Alice", last_name: "Smith" }],
            govt_entities: ["SENATE"],
          },
          {
            code: "HCR",
            display: "Health",
            lobbyists: [{ id: 11, first_name: "Bob", last_name: "Jones", new: true }],
            govt_entities: ["HOUSE OF REPRESENTATIVES"],
          },
        ],
      }),
    ];
    await upsertFilingsBatch(db, [...fromFilings, ...toFilings]);

    // Stub the LDA client's paginate so listFilingsForClient returns our
    // fixtures (the skill filters on filing_year after fetching).
    const fake = new FakeLdaClient([...fromFilings, ...toFilings]);
    // Under-the-hood call sequence: listFilingsForClient → client.paginate.
    // Because paginate returns [], no new filings get mirrored, but the
    // skill then reads the *merged* superset filings — which include ours.

    const brief = await runFilingDiff(fake as unknown as LdaClient, db, {
      client_id: 777,
      from_window: { year_start: 2020, year_end: 2020, quarter: 1 },
      to_window: { year_start: 2024, year_end: 2024, quarter: 1 },
    });

    expect(brief.data.deltas.spend_delta).toBe(70000);
    // HCR was added, TAX persisted
    const addedCodes = brief.data.deltas.issues_added.map((i) => i.code);
    expect(addedCodes).toContain("HCR");
    // Bob Jones was added
    const addedNames = brief.data.deltas.lobbyists_added.map((l) => l.name);
    expect(addedNames).toContain("Bob Jones");
    // HOUSE OF REPRESENTATIVES was added
    expect(brief.data.deltas.govt_entities_added).toContain("HOUSE OF REPRESENTATIVES");
  });
});
