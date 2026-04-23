/**
 * Smoke test for anomaly-scan's pattern detection. Same stub-based
 * approach as filing-diff.test.ts.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbClient } from "../src/db/engine.ts";
import { upsertFilingsBatch } from "../src/db/repos.ts";
import { runAnomalyScan } from "../src/skills/anomaly-scan.ts";
import type { LdaClient } from "../src/core/lda-client.ts";
import { mkFiling } from "./_fixtures.ts";

let tmp: string;
let db: DbClient;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lobbyist-anomaly-"));
  db = await openDb({ dataDir: tmp });
});
afterEach(async () => {
  await db.close();
  await rm(tmp, { recursive: true, force: true });
});

class FakeLda {
  constructor(public fixtures: any[] = []) {}
  async paginate(_path: string, query: Record<string, unknown> = {}): Promise<any[]> {
    if (query.filing_year !== undefined) {
      const y = Number(query.filing_year);
      return this.fixtures.filter((f) => f.filing_year === y);
    }
    return this.fixtures;
  }
}

describe("anomaly-scan", () => {
  test("flags ex-staffer hires, new lobbyists, late filings, issue churn", async () => {
    const filings = [
      mkFiling({
        uuid: "a1",
        year: 2023,
        quarter: 1,
        client_id: 42,
        client_name: "Widgets Inc",
        registrant_id: 900,
        registrant_name: "FirmOne",
        income: "50000.00",
        dt_posted: "2023-04-20T12:00:00Z",
        issues: [
          {
            code: "TAX",
            display: "Taxation",
            lobbyists: [{ id: 10, first_name: "Alice", last_name: "Smith" }],
          },
        ],
      }),
      mkFiling({
        uuid: "a2",
        year: 2023,
        quarter: 2,
        client_id: 42,
        client_name: "Widgets Inc",
        registrant_id: 900,
        registrant_name: "FirmOne",
        income: "55000.00",
        // Late filing — posted 200 days after Q2 end (2023-06-30).
        dt_posted: "2024-01-16T12:00:00Z",
        issues: [
          {
            code: "HCR", // Issue churn: TAX → HCR
            display: "Health",
            lobbyists: [
              {
                id: 11,
                first_name: "Bob",
                last_name: "Jones",
                new: true,
                covered_position: "Chief of Staff, Senator Example",
              },
            ],
            govt_entities: ["SENATE"],
          },
        ],
      }),
    ];
    await upsertFilingsBatch(db, filings);

    const brief = await runAnomalyScan(new FakeLda(filings) as unknown as LdaClient, db, {
      client_id: 42,
      year_start: 2023,
      year_end: 2023,
    });

    const kinds = brief.data.flags.map((f) => f.kind);
    expect(kinds).toContain("late_filing");
    expect(kinds).toContain("new_lobbyist");
    expect(kinds).toContain("ex_staffer_hire");
    expect(kinds).toContain("issue_churn");
    expect(kinds).toContain("new_govt_entity");
    expect(brief.data.totals.flags_raised).toBeGreaterThanOrEqual(5);
  });

  test("clean filings raise no flags", async () => {
    const filings = [
      mkFiling({
        uuid: "clean1",
        year: 2023,
        quarter: 1,
        client_id: 99,
        client_name: "Tidy Corp",
        registrant_id: 900,
        registrant_name: "FirmOne",
        income: "40000.00",
        dt_posted: "2023-04-15T12:00:00Z",
        issues: [
          {
            code: "TAX",
            display: "Taxation",
            lobbyists: [{ id: 20, first_name: "Clean", last_name: "Hire" }],
          },
        ],
      }),
      mkFiling({
        uuid: "clean2",
        year: 2023,
        quarter: 2,
        client_id: 99,
        client_name: "Tidy Corp",
        registrant_id: 900,
        registrant_name: "FirmOne",
        income: "40000.00",
        dt_posted: "2023-07-15T12:00:00Z",
        issues: [
          {
            code: "TAX",
            display: "Taxation",
            lobbyists: [{ id: 20, first_name: "Clean", last_name: "Hire" }],
          },
        ],
      }),
    ];
    await upsertFilingsBatch(db, filings);
    const brief = await runAnomalyScan(new FakeLda(filings) as unknown as LdaClient, db, {
      client_id: 99,
      year_start: 2023,
      year_end: 2023,
    });
    expect(brief.data.totals.flags_raised).toBe(0);
  });
});
