/**
 * Shared fixture helpers for skill tests. Constructs Filing objects
 * matching the LDA API shape without touching the network.
 *
 * This is test-only synthetic data. Per CLAUDE.md, no synthetic data goes
 * into production code paths — only here in /test.
 */

import type { Filing } from "../src/core/lda-endpoints.ts";

export function mkFiling(overrides: {
  uuid: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  client_id: number;
  client_name: string;
  registrant_id: number;
  registrant_name: string;
  income?: string | null;
  expenses?: string | null;
  issues?: Array<{
    code: string;
    display?: string;
    lobbyists?: Array<{
      id: number;
      first_name?: string;
      last_name?: string;
      covered_position?: string;
      new?: boolean;
    }>;
    govt_entities?: string[];
  }>;
  dt_posted?: string;
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
    dt_posted: overrides.dt_posted ?? `${overrides.year}-04-20T12:00:00Z`,
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
      general_issue_code_display: i.display ?? i.code,
      description: "test description",
      foreign_entity_issues: null,
      lobbyists: (i.lobbyists ?? []).map((la) => ({
        lobbyist: {
          id: la.id,
          first_name: la.first_name ?? null,
          last_name: la.last_name ?? null,
          suffix: null,
        },
        covered_position: la.covered_position ?? null,
        new: la.new ?? null,
      })),
      government_entities: (i.govt_entities ?? []).map((name) => ({
        id: null,
        name,
      })),
    })),
    conviction_disclosures: [],
    foreign_entities: [],
    affiliated_organizations: [],
  } as unknown as Filing;
}
