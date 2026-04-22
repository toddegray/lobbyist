/**
 * Minimal OpenFEC endpoint wrappers for lobbyist.
 *
 * Intentionally narrow. lobbyist joins LDA ↔ FEC at only a few seams:
 *
 *   1. Candidate lookup (name → candidate_id)
 *      — So committee-influence can take a member name and find the campaign
 *        committees that money flows into.
 *
 *   2. Candidate → principal campaign committee list
 *      — The entity that actually receives ScheduleA contributions.
 *
 *   3. ScheduleA receipts by employer substring
 *      — Surfaces contributions from a named firm's employees to a member.
 *      — E.g. committee-influence asks "did Akin Gump employees give to this
 *        senator?" by filtering ScheduleA on employer="AKIN GUMP".
 *
 * This file uses the ported OpenFecClient. It does NOT attempt to reproduce
 * fec-analyst's full endpoint surface — just the three joins lobbyist needs.
 */

import { z } from "zod";
import type { OpenFecClient } from "./openfec-client.ts";

// ---------------------------------------------------------------------------
// Candidate search
// ---------------------------------------------------------------------------

const CandidateSearchResultSchema = z
  .object({
    candidate_id: z.string(),
    name: z.string().nullable().optional(),
    party: z.string().nullable().optional(),
    office: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    district: z.string().nullable().optional(),
    incumbent_challenge: z.string().nullable().optional(),
    election_years: z.array(z.number()).nullable().optional(),
    principal_committees: z
      .array(
        z
          .object({
            committee_id: z.string(),
            name: z.string().nullable().optional(),
            designation: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

const CandidateSearchResponse = z.object({
  results: z.array(CandidateSearchResultSchema),
});

export type CandidateSearchResult = z.infer<typeof CandidateSearchResultSchema>;

export async function searchCandidates(
  client: OpenFecClient,
  name: string,
): Promise<CandidateSearchResult[]> {
  const res = await client.get("/candidates/search", { q: name, per_page: 20 }, CandidateSearchResponse);
  return res.results;
}

// ---------------------------------------------------------------------------
// Candidate → principal campaign committees
// ---------------------------------------------------------------------------

const CandidateCommitteeSchema = z
  .object({
    committee_id: z.string(),
    name: z.string().nullable().optional(),
    designation: z.string().nullable().optional(),
    committee_type: z.string().nullable().optional(),
    cycle: z.number().int().nullable().optional(),
  })
  .passthrough();

const CandidateCommitteesResponse = z.object({
  results: z.array(CandidateCommitteeSchema),
});

export type CandidateCommittee = z.infer<typeof CandidateCommitteeSchema>;

export async function getCandidateCommittees(
  client: OpenFecClient,
  candidateId: string,
  cycle?: number,
): Promise<CandidateCommittee[]> {
  const q: Record<string, string | number> = { per_page: 50 };
  if (cycle) q.cycle = cycle;
  // Principal + authorized committees. "designation=P" = principal only.
  q.designation = "P";
  const res = await client.get(
    `/candidate/${encodeURIComponent(candidateId)}/committees`,
    q,
    CandidateCommitteesResponse,
  );
  return res.results;
}

// ---------------------------------------------------------------------------
// ScheduleA: receipts filtered by contributor employer substring
// ---------------------------------------------------------------------------

const ScheduleAReceiptSchema = z
  .object({
    sub_id: z.string().nullable().optional(),
    committee_id: z.string().nullable().optional(),
    contributor_name: z.string().nullable().optional(),
    contributor_employer: z.string().nullable().optional(),
    contributor_occupation: z.string().nullable().optional(),
    contributor_state: z.string().nullable().optional(),
    contribution_receipt_amount: z.number().nullable().optional(),
    contribution_receipt_date: z.string().nullable().optional(),
    image_number: z.string().nullable().optional(),
  })
  .passthrough();

const ScheduleAResponse = z.object({
  results: z.array(ScheduleAReceiptSchema),
  pagination: z
    .object({
      count: z.number().int().nullable().optional(),
      pages: z.number().int().nullable().optional(),
      per_page: z.number().int().nullable().optional(),
      page: z.number().int().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

export type ScheduleAReceipt = z.infer<typeof ScheduleAReceiptSchema>;

/**
 * Sum of itemized individual contributions from a named-employer pool to a
 * given committee over a cycle. Uses OpenFEC's contributor_employer
 * substring match. Pages up to `maxPages` deep.
 */
export async function sumReceiptsByEmployer(
  client: OpenFecClient,
  opts: {
    committee_id: string;
    employer: string;          // substring match on contributor_employer
    cycle: number;
    perPage?: number;
    maxPages?: number;
  },
): Promise<{ count: number; total: number; sample: ScheduleAReceipt[] }> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 5;
  let total = 0;
  let count = 0;
  const sample: ScheduleAReceipt[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const res = await client.get(
      "/schedules/schedule_a",
      {
        committee_id: opts.committee_id,
        contributor_employer: opts.employer,
        two_year_transaction_period: opts.cycle,
        per_page: perPage,
        page,
      },
      ScheduleAResponse,
    );
    for (const r of res.results) {
      const amt = r.contribution_receipt_amount;
      if (typeof amt === "number" && Number.isFinite(amt)) total += amt;
      count += 1;
      if (sample.length < 10) sample.push(r);
    }
    const pagination = res.pagination;
    if (!pagination) break;
    const pages = pagination.pages ?? 1;
    if (page >= (pages || 1)) break;
  }
  return { count, total, sample };
}

// ---------------------------------------------------------------------------
// Helper URL builders
// ---------------------------------------------------------------------------

export function fecCandidateUrl(candidateId: string): string {
  return `https://www.fec.gov/data/candidate/${encodeURIComponent(candidateId)}/`;
}
export function fecCommitteeUrl(committeeId: string): string {
  return `https://www.fec.gov/data/committee/${encodeURIComponent(committeeId)}/`;
}
