/**
 * committee-influence — LDA + FEC join.
 *
 * Given a member of Congress (by FEC candidate_id or by name + office), we:
 *
 *   1. Resolve to a concrete FEC candidate_id + principal campaign committee.
 *   2. Fetch LDA filings whose lobbying_activities mention the chamber's
 *      committees of jurisdiction (by govt_entity name substring — crude but
 *      it works). This gives us a population of lobbying clients plausibly
 *      working issues the member has a hand in.
 *   3. For each of the top clients in that population (by spend), query
 *      FEC ScheduleA receipts filtered by contributor_employer=<client name>
 *      to the member's principal committee. Sum the contributions.
 *
 * Output: ranked list of clients with (LDA filings on relevant issues, FEC
 * contributions from client-employed individuals to the member's campaign),
 * plus the two totals.
 *
 * What we explicitly DO NOT do:
 *   - Claim a donation bought a vote.
 *   - Claim causality in either direction.
 *   - Infer the member's policy positions.
 *
 * This skill's value is surfacing the disclosed overlap between "hired
 * lobbyists on issues this member handles" and "wrote checks to this
 * member's campaign." The reader draws the rest of the picture.
 */

import type { LdaClient } from "../core/lda-client.ts";
import type { OpenFecClient } from "../core/openfec-client.ts";
import {
  listFilingsByIssueCode,
  filingHumanUrl,
  filingSpend,
  type Filing,
} from "../core/lda-endpoints.ts";
import {
  getCandidateCommittees,
  searchCandidates,
  sumReceiptsByEmployer,
  fecCandidateUrl,
  fecCommitteeUrl,
} from "../core/openfec-endpoints.ts";
import type { DbClient } from "../db/engine.ts";
import { upsertFilingsBatch } from "../db/repos.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";
import { fmtUsd } from "../core/types.ts";

export const SKILL_NAME = "committee-influence";
export const SCHEMA_VERSION = 1;

export interface CommitteeInfluenceInput {
  /** Free-text member name, e.g. "Jon Tester". Ignored if candidate_id set. */
  member?: string;
  candidate_id?: string;
  /** LDA issue codes of jurisdiction, e.g. ["HCR","MMM"] for a HELP member. */
  issue_codes: string[];
  year_start: number;
  year_end: number;
  /** FEC election cycle to query ScheduleA for (typically year_end). */
  cycle: number;
  /** Number of top lobbying clients to probe for FEC overlap. Default 10. */
  top_n_clients?: number;
}

export interface CommitteeInfluenceData {
  member: {
    candidate_id: string;
    name: string;
    party: string | null;
    state: string | null;
    office: string | null;
    principal_committee_id: string | null;
    principal_committee_name: string | null;
  };
  window: TimeWindow;
  issue_codes: string[];
  fec_cycle: number;
  lda_totals: {
    filings: number;
    unique_clients: number;
    reported_spend_sum: number;
  };
  fec_totals: {
    clients_probed: number;
    clients_with_contribs: number;
    total_contrib: number;
  };
  overlap: Array<{
    client_id: number;
    client_name: string;
    lda_filings: number;
    lda_reported_spend: number;
    fec_contrib_total: number;
    fec_contrib_count: number;
    exemplar_filing_uuid: string;
    exemplar_filing_url: string;
  }>;
}

// ---------------------------------------------------------------------------

export async function runCommitteeInfluence(
  lda: LdaClient,
  fec: OpenFecClient,
  db: DbClient,
  input: CommitteeInfluenceInput,
): Promise<Brief<CommitteeInfluenceData>> {
  if (input.issue_codes.length === 0) {
    throw new Error("committee-influence requires at least one LDA issue code.");
  }

  // 1. Resolve member → FEC candidate_id + principal committee
  let candidate_id = input.candidate_id;
  let member_name = input.member ?? candidate_id ?? "unknown";
  let party: string | null = null;
  let state: string | null = null;
  let office: string | null = null;

  if (!candidate_id) {
    if (!input.member) {
      throw new Error("committee-influence requires `member` or `candidate_id`.");
    }
    const hits = await searchCandidates(fec, input.member);
    if (hits.length === 0) {
      throw new Error(`committee-influence: no FEC candidate matched "${input.member}".`);
    }
    // FEC's candidate search ranks by name-match quality, not recency — so
    // "Bernie Sanders" can return the long-defunct 1988–2006 House Sanders
    // ahead of the current Senate Sanders. Prefer candidates whose
    // election_years include the target cycle; fall back to all hits if
    // none match that filter.
    const activeInCycle = hits.filter((c) =>
      (c.election_years ?? []).includes(input.cycle),
    );
    const pool = activeInCycle.length > 0 ? activeInCycle : hits;
    const best = pool[0]!;
    candidate_id = best.candidate_id;
    member_name = best.name ?? input.member;
    party = best.party ?? null;
    state = best.state ?? null;
    office = best.office ?? null;
  }

  const committees = await getCandidateCommittees(fec, candidate_id, input.cycle);
  const principal = committees[0] ?? null;
  const principal_committee_id = principal?.committee_id ?? null;
  const principal_committee_name = principal?.name ?? null;

  // 2. Fetch LDA filings touching any of the member's jurisdictional issue codes
  const allFilings: Filing[] = [];
  for (const code of input.issue_codes) {
    const batch = await listFilingsByIssueCode(lda, {
      issueCode: code,
      yearStart: input.year_start,
      yearEnd: input.year_end,
    });
    allFilings.push(...batch);
  }
  // De-dupe by filing_uuid (a single filing can touch multiple issue codes).
  const uuidSeen = new Set<string>();
  const filings = allFilings.filter((f) => {
    if (uuidSeen.has(f.filing_uuid)) return false;
    uuidSeen.add(f.filing_uuid);
    return true;
  });
  await upsertFilingsBatch(db, filings);

  // Aggregate by client
  const clientAgg = new Map<
    number,
    { name: string; filings: number; spend: number; exemplar: Filing }
  >();
  let ldaSpendSum = 0;
  for (const f of filings) {
    const spend = filingSpend(f) ?? 0;
    ldaSpendSum += spend;
    const cid = f.client.id;
    const cur =
      clientAgg.get(cid) ?? { name: f.client.name, filings: 0, spend: 0, exemplar: f };
    cur.filings += 1;
    cur.spend += spend;
    clientAgg.set(cid, cur);
  }

  const topN = input.top_n_clients ?? 10;
  const topClients = [...clientAgg.entries()]
    .sort((a, b) => b[1].spend - a[1].spend || b[1].filings - a[1].filings)
    .slice(0, topN);

  // 3. For each top client, query FEC contributions from their employer pool
  //    to the member's principal committee.
  const overlap: CommitteeInfluenceData["overlap"] = [];
  let clients_with_contribs = 0;
  let total_contrib = 0;

  if (principal_committee_id) {
    for (const [cid, agg] of topClients) {
      const receipts = await sumReceiptsByEmployer(fec, {
        committee_id: principal_committee_id,
        employer: agg.name,
        cycle: input.cycle,
      });
      if (receipts.total > 0) {
        clients_with_contribs += 1;
        total_contrib += receipts.total;
      }
      overlap.push({
        client_id: cid,
        client_name: agg.name,
        lda_filings: agg.filings,
        lda_reported_spend: agg.spend,
        fec_contrib_total: receipts.total,
        fec_contrib_count: receipts.count,
        exemplar_filing_uuid: agg.exemplar.filing_uuid,
        exemplar_filing_url: filingHumanUrl(agg.exemplar),
      });
    }
  }

  const data: CommitteeInfluenceData = {
    member: {
      candidate_id: candidate_id!,
      name: member_name,
      party,
      state,
      office,
      principal_committee_id,
      principal_committee_name,
    },
    window: { year_start: input.year_start, year_end: input.year_end },
    issue_codes: input.issue_codes,
    fec_cycle: input.cycle,
    lda_totals: {
      filings: filings.length,
      unique_clients: clientAgg.size,
      reported_spend_sum: ldaSpendSum,
    },
    fec_totals: {
      clients_probed: topClients.length,
      clients_with_contribs,
      total_contrib,
    },
    overlap,
  };

  const citations = buildCitations(data);
  const entity: EntityId = {
    kind: "member",
    id: candidate_id!,
    display: member_name,
  };
  const markdown = renderMarkdown(data);

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    entity,
    window: data.window,
    generated_at: new Date().toISOString(),
    data,
    citations,
    markdown,
  };
}

// ---------------------------------------------------------------------------

function buildCitations(data: CommitteeInfluenceData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();

  cites.push({
    key: "member_fec",
    description: `FEC record for ${data.member.name}`,
    source: "fec",
    url: fecCandidateUrl(data.member.candidate_id),
    source_id: data.member.candidate_id,
    fetched_at,
  });
  if (data.member.principal_committee_id) {
    cites.push({
      key: "committee_fec",
      description: `Principal campaign committee ${data.member.principal_committee_name ?? data.member.principal_committee_id}`,
      source: "fec",
      url: fecCommitteeUrl(data.member.principal_committee_id),
      source_id: data.member.principal_committee_id,
      fetched_at,
    });
  }
  for (const o of data.overlap) {
    cites.push({
      key: `lda_${o.client_id}`,
      description: `LDA filings by ${o.client_name} on ${data.issue_codes.join(", ")}`,
      source: "lda",
      url: o.exemplar_filing_url,
      source_id: o.exemplar_filing_uuid,
      fetched_at,
    });
  }
  return cites;
}

function renderMarkdown(data: CommitteeInfluenceData): string {
  const lines: string[] = [];
  lines.push(
    `## Committee-of-jurisdiction influence: ${data.member.name}${data.member.party ? ` (${data.member.party})` : ""}${data.member.state ? `-${data.member.state}` : ""}`,
  );
  lines.push("");
  lines.push(
    `Issue codes examined: **${data.issue_codes.join(", ")}**. Window: ${data.window.year_start}–${data.window.year_end}. FEC cycle: ${data.fec_cycle}.`,
  );
  lines.push("");

  if (!data.member.principal_committee_id) {
    lines.push(
      `> No principal campaign committee found for ${data.member.name} in cycle ${data.fec_cycle}. FEC-side numbers will be omitted.`,
    );
  }

  lines.push(
    `On the LDA side: **${data.lda_totals.unique_clients}** clients filed **${data.lda_totals.filings}** filings on these issues, with **${fmtUsd(data.lda_totals.reported_spend_sum)}** reported spend.`,
  );
  if (data.member.principal_committee_id) {
    lines.push(
      `On the FEC side: of the top ${data.fec_totals.clients_probed} lobbying clients, **${data.fec_totals.clients_with_contribs}** had employees contribute to ${data.member.principal_committee_name ?? "the principal committee"} [committee_fec], totalling **${fmtUsd(data.fec_totals.total_contrib)}**.`,
    );
  }

  if (data.overlap.length > 0) {
    lines.push("");
    lines.push("### LDA spend × FEC contributions (top clients)");
    lines.push("");
    lines.push("| Client | LDA filings | LDA spend | FEC contribs | Contrib txns |");
    lines.push("| ------ | ----------- | --------- | ------------ | ------------ |");
    for (const o of data.overlap) {
      lines.push(
        `| **${o.client_name}** [lda_${o.client_id}] | ${o.lda_filings} | ${fmtUsd(o.lda_reported_spend)} | ${fmtUsd(o.fec_contrib_total)} | ${o.fec_contrib_count} |`,
      );
    }
  }

  lines.push("");
  lines.push(
    "> Disclosed overlap between lobbying spend and campaign contributions. This is NOT a claim of quid-pro-quo; causality cannot be inferred from the filings. The tool surfaces the overlap; the reader decides what it means.",
  );
  return lines.join("\n");
}
