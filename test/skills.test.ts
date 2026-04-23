/**
 * Smoke tests for skill aggregation. We exercise the pure aggregation paths
 * with synthesized Filing payloads so the tests run without network.
 *
 * Rule from CLAUDE.md: no synthetic data in production. These fixtures are
 * test-only, constructed to match the LDA schema exactly, and live in /test.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbClient } from "../src/db/engine.ts";
import { upsertFilingsBatch, listFilingsForClient } from "../src/db/repos.ts";
import type { Filing } from "../src/core/lda-endpoints.ts";
import { filingQuarter, filingSpend } from "../src/core/lda-endpoints.ts";

let tmp: string;
let db: DbClient;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lobbyist-skills-"));
  db = await openDb({ dataDir: tmp });
});

afterEach(async () => {
  await db.close();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Tiny factory for a test-only Filing. Matches the shape the zod schema
 * produces after .parse() — permissive on optional fields.
 */
function mkFiling(overrides: {
  uuid: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  client_id: number;
  client_name: string;
  registrant_id: number;
  registrant_name: string;
  income?: string | null;
  expenses?: string | null;
  issues?: Array<{ code: string; display: string }>;
}): Filing {
  const periodMap = {
    1: "first_quarter",
    2: "second_quarter",
    3: "third_quarter",
    4: "fourth_quarter",
  } as const;
  return {
    url: `https://lda.senate.gov/api/v1/filings/${overrides.uuid}/`,
    filing_uuid: overrides.uuid,
    filing_type: `Q${overrides.quarter}`,
    filing_type_display: null,
    filing_year: overrides.year,
    filing_period: periodMap[overrides.quarter],
    filing_period_display: null,
    filing_document_url: `https://lda.senate.gov/filings/public/filing/${overrides.uuid}/print/`,
    income: overrides.income ?? null,
    expenses: overrides.expenses ?? null,
    expenses_method: null,
    expenses_method_display: null,
    posted_by_name: null,
    dt_posted: `${overrides.year}-04-20T12:00:00Z`,
    registrant: {
      id: overrides.registrant_id,
      name: overrides.registrant_name,
      description: null,
      address_1: null,
      city: null,
      state: "DC",
      country: "USA",
    },
    client: {
      id: overrides.client_id,
      name: overrides.client_name,
      general_description: null,
      client_government_entity: false,
      state: "NY",
      country: "USA",
    },
    lobbying_activities: (overrides.issues ?? []).map((i) => ({
      general_issue_code: i.code,
      general_issue_code_display: i.display,
      description: "test description",
      foreign_entity_issues: null,
      lobbyists: [],
      government_entities: [],
    })),
    conviction_disclosures: [],
    foreign_entities: [],
    affiliated_organizations: [],
  } as unknown as Filing;
}

describe("lda-endpoints helpers", () => {
  test("filingSpend picks income or expenses, never both", () => {
    const fIncome = mkFiling({
      uuid: "a",
      year: 2023,
      quarter: 1,
      client_id: 1,
      client_name: "C",
      registrant_id: 2,
      registrant_name: "R",
      income: "50000.00",
    });
    const fExpenses = mkFiling({
      uuid: "b",
      year: 2023,
      quarter: 1,
      client_id: 1,
      client_name: "C",
      registrant_id: 2,
      registrant_name: "R",
      expenses: "30000.00",
    });
    const fNeither = mkFiling({
      uuid: "c",
      year: 2023,
      quarter: 1,
      client_id: 1,
      client_name: "C",
      registrant_id: 2,
      registrant_name: "R",
    });
    expect(filingSpend(fIncome)).toBe(50000);
    expect(filingSpend(fExpenses)).toBe(30000);
    expect(filingSpend(fNeither)).toBeNull();
  });

  test("filingQuarter decodes filing_period", () => {
    const f1 = mkFiling({
      uuid: "q1",
      year: 2023,
      quarter: 1,
      client_id: 1,
      client_name: "C",
      registrant_id: 2,
      registrant_name: "R",
    });
    const f4 = mkFiling({
      uuid: "q4",
      year: 2023,
      quarter: 4,
      client_id: 1,
      client_name: "C",
      registrant_id: 2,
      registrant_name: "R",
    });
    expect(filingQuarter(f1)).toBe(1);
    expect(filingQuarter(f4)).toBe(4);
  });
});

describe("db filings mirror", () => {
  test("upsertFilingsBatch mirrors and grows the alias graph", async () => {
    const filings = [
      mkFiling({
        uuid: "f1",
        year: 2023,
        quarter: 1,
        client_id: 100,
        client_name: "Pfizer Inc",
        registrant_id: 200,
        registrant_name: "Akin Gump Strauss Hauer & Feld LLP",
        income: "120000.00",
      }),
      mkFiling({
        uuid: "f2",
        year: 2023,
        quarter: 2,
        client_id: 100,
        client_name: "Pfizer Inc",
        registrant_id: 200,
        registrant_name: "Akin Gump Strauss Hauer & Feld LLP",
        income: "130000.00",
      }),
    ];
    await upsertFilingsBatch(db, filings);

    const loaded = await listFilingsForClient(db, { clientId: 100 });
    expect(loaded.length).toBe(2);
    const uuids = loaded.map((f) => f.filing_uuid).sort();
    expect(uuids).toEqual(["f1", "f2"]);

    // Alias graph should now contain the client name.
    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM entity_aliases WHERE normalized = 'PFIZER'`,
    );
    expect(rows[0]!.count).toBeGreaterThan(0);
  });

  test("re-upsert is idempotent on filing_uuid", async () => {
    const f = mkFiling({
      uuid: "same",
      year: 2023,
      quarter: 1,
      client_id: 100,
      client_name: "Acme",
      registrant_id: 200,
      registrant_name: "Firm",
      income: "1000.00",
    });
    await upsertFilingsBatch(db, [f, f, f]);
    const rows = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM filings`);
    expect(rows[0]!.count).toBe(1);
  });
});
