/**
 * Smoke test for coalition-detect's grouping + confidence score.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbClient } from "../src/db/engine.ts";
import { upsertFilingsBatch } from "../src/db/repos.ts";
import { runCoalitionDetect } from "../src/skills/coalition-detect.ts";
import type { LdaClient } from "../src/core/lda-client.ts";
import { mkFiling } from "./_fixtures.ts";

let tmp: string;
let db: DbClient;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lobbyist-coal-"));
  db = await openDb({ dataDir: tmp });
});
afterEach(async () => {
  await db.close();
  await rm(tmp, { recursive: true, force: true });
});

class FakeLda {
  async paginate(): Promise<any[]> {
    return [];
  }
  async get(): Promise<any> {
    // coalition-detect in by-issue mode calls the endpoint helpers that call
    // client.paginate, which we stub. This .get won't be hit.
    throw new Error("not expected");
  }
}

describe("coalition-detect by_issue", () => {
  test("three clients sharing one firm on one issue form a coalition", async () => {
    const filings = [
      mkFiling({
        uuid: "c1",
        year: 2023,
        quarter: 1,
        client_id: 100,
        client_name: "Big Pharma A",
        registrant_id: 900,
        registrant_name: "K-Street LLP",
        income: "50000.00",
        issues: [{ code: "HCR", display: "Health" }],
      }),
      mkFiling({
        uuid: "c2",
        year: 2023,
        quarter: 1,
        client_id: 101,
        client_name: "Big Pharma B",
        registrant_id: 900,
        registrant_name: "K-Street LLP",
        income: "60000.00",
        issues: [{ code: "HCR", display: "Health" }],
      }),
      mkFiling({
        uuid: "c3",
        year: 2023,
        quarter: 1,
        client_id: 102,
        client_name: "Big Pharma C",
        registrant_id: 900,
        registrant_name: "K-Street LLP",
        income: "70000.00",
        issues: [{ code: "HCR", display: "Health" }],
      }),
    ];
    await upsertFilingsBatch(db, filings);
    // In by-issue mode the skill calls listFilingsByIssueCode, which maps
    // to client.paginate. Stub returns empty — but the mirrored filings
    // already grew the DB. That said, the skill uses only the freshly-
    // fetched list for analysis. So we need to make the fake return our
    // fixtures. Simplest: upsert before, and pass a fake that returns them.
    class FakeLdaWithPage {
      async paginate(): Promise<any> {
        return filings;
      }
      async get(): Promise<any> {
        return { count: filings.length, next: null, previous: null, results: filings };
      }
    }

    const brief = await runCoalitionDetect(new FakeLdaWithPage() as unknown as LdaClient, db, {
      issue_code: "HCR",
      year_start: 2023,
      year_end: 2023,
      min_coalition_size: 2,
    });

    expect(brief.data.coalitions.length).toBe(1);
    expect(brief.data.coalitions[0]!.client_count).toBe(3);
    expect(brief.data.coalitions[0]!.registrant_name).toBe("K-Street LLP");
  });
});
