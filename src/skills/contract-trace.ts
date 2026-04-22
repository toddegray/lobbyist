/**
 * contract-trace — LDA + USASpending join.
 *
 * Given a client (company) and a year range, we compute:
 *
 *   - Total LDA-filed lobbying spend (from the `filings` mirror + API if
 *     we haven't seen the client yet).
 *   - Total USASpending federal contract awards to that recipient in the
 *     same window.
 *   - A lobbying-to-contracts ratio ($contracts_awarded / $lobbying_spent).
 *   - Top contract awards (descending by amount) with agency, time range,
 *     and a description.
 *   - Top awarding agencies.
 *
 * Output is a Brief<ContractTraceData>. The skill labels the ROI ratio
 * explicitly as **derived analysis** — not a filed fact — per CLAUDE.md
 * rule #9.
 *
 * Important caveat we surface in the narrative: federal contracts awarded
 * to a lobbying client are not proof that lobbying caused them. The tool
 * reports the co-occurrence.
 */

import type { LdaClient } from "../core/lda-client.ts";
import type { UsaSpendingClient } from "../core/usaspending-client.ts";
import {
  filingSpend,
  filingHumanUrl,
  type Filing,
} from "../core/lda-endpoints.ts";
import {
  searchContractAwards,
  awardAmount,
  awardHumanUrl,
  awardYear,
  type AwardRow,
} from "../core/usaspending-endpoints.ts";
import { resolveClient } from "../core/resolve.ts";
import type { DbClient } from "../db/engine.ts";
import {
  listFilingsForClientId,
  totalSpendForClient,
  upsertFilingsBatch,
} from "../db/repos.ts";
import { listFilingsForClient } from "../core/lda-endpoints.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";
import { fmtUsd } from "../core/types.ts";

export const SKILL_NAME = "contract-trace";
export const SCHEMA_VERSION = 1;

export interface ContractTraceInput {
  client?: string;
  client_id?: number;
  year_start: number;
  year_end: number;
  /** Recipient-name substring for USASpending. Defaults to the LDA client name. */
  usaspending_recipient?: string;
}

export interface ContractTraceData {
  client: { client_id: number; name: string };
  window: TimeWindow;
  lda: {
    filings: number;
    total_lobbying_spend: number;
    first_filing_year: number | null;
    last_filing_year: number | null;
    exemplar_filing_uuid: string | null;
    exemplar_filing_url: string | null;
  };
  usaspending: {
    recipient_query: string;
    awards_returned: number;
    total_award_amount: number;
    by_year: Array<{ year: number; total: number; award_count: number }>;
    top_agencies: Array<{ agency: string; total: number; award_count: number }>;
    top_awards: Array<{
      award_id: string | null;
      generated_internal_id: string | null;
      recipient: string | null;
      amount: number;
      agency: string | null;
      start_date: string | null;
      end_date: string | null;
      description: string | null;
      human_url: string;
    }>;
  };
  /** Derived analysis — not a filed fact. */
  derived: {
    contracts_per_dollar_lobbied: number | null;   // total_contracts / total_lobbying, null if lobbying==0
    label: string;                                   // "derived: ratio, not causal"
  };
}

// ---------------------------------------------------------------------------

export async function runContractTrace(
  lda: LdaClient,
  usa: UsaSpendingClient,
  db: DbClient,
  input: ContractTraceInput,
): Promise<Brief<ContractTraceData>> {
  // 1. Resolve LDA client
  let client_id = input.client_id;
  let client_name: string;
  if (client_id === undefined) {
    if (!input.client) throw new Error("contract-trace requires `client` or `client_id`.");
    const res = await resolveClient(db, lda, input.client);
    if (!res) throw new Error(`contract-trace: no LDA client matched "${input.client}".`);
    client_id = res.client_id;
    client_name = res.name;
  } else {
    client_name = `client #${client_id}`;
  }

  // 2. Pull LDA filings (so we have an authoritative lobbying total)
  const freshFilings = await listFilingsForClient(lda, {
    clientId: client_id,
    yearStart: input.year_start,
    yearEnd: input.year_end,
  });
  await upsertFilingsBatch(db, freshFilings);
  if (freshFilings[0]) client_name = freshFilings[0].client.name;

  const storedFilings = await listFilingsForClientId(db, client_id, {
    yearStart: input.year_start,
    yearEnd: input.year_end,
  });
  const total_lobbying = await totalSpendForClient(db, client_id, {
    yearStart: input.year_start,
    yearEnd: input.year_end,
  });
  const exemplar = storedFilings[0] ?? null;

  // 3. Query USASpending for federal contract awards to this recipient
  const recipientQuery = input.usaspending_recipient ?? client_name;
  const awards = await searchContractAwards(usa, {
    recipient: recipientQuery,
    yearStart: input.year_start,
    yearEnd: input.year_end,
  });

  // 4. Aggregate USASpending side
  let totalAward = 0;
  const byYear = new Map<number, { total: number; count: number }>();
  const byAgency = new Map<string, { total: number; count: number }>();
  for (const a of awards) {
    const amt = awardAmount(a);
    totalAward += amt;
    const y = awardYear(a);
    if (y !== null) {
      const row = byYear.get(y) ?? { total: 0, count: 0 };
      row.total += amt;
      row.count += 1;
      byYear.set(y, row);
    }
    const agency = a["Awarding Agency"] ?? "(unspecified)";
    const arow = byAgency.get(agency) ?? { total: 0, count: 0 };
    arow.total += amt;
    arow.count += 1;
    byAgency.set(agency, arow);
  }

  const topAwards = [...awards]
    .sort((a, b) => awardAmount(b) - awardAmount(a))
    .slice(0, 15)
    .map((a) => ({
      award_id: a["Award ID"] ?? null,
      generated_internal_id: a.generated_internal_id ?? null,
      recipient: a["Recipient Name"] ?? null,
      amount: awardAmount(a),
      agency: a["Awarding Agency"] ?? null,
      start_date: a["Start Date"] ?? null,
      end_date: a["End Date"] ?? null,
      description: a["Description"] ?? null,
      human_url: awardHumanUrl(a),
    }));

  const ratio = total_lobbying > 0 ? totalAward / total_lobbying : null;

  const firstYear = storedFilings.length > 0
    ? Math.min(...storedFilings.map((f) => f.filing_year))
    : null;
  const lastYear = storedFilings.length > 0
    ? Math.max(...storedFilings.map((f) => f.filing_year))
    : null;

  const data: ContractTraceData = {
    client: { client_id, name: client_name },
    window: { year_start: input.year_start, year_end: input.year_end },
    lda: {
      filings: storedFilings.length,
      total_lobbying_spend: total_lobbying,
      first_filing_year: firstYear,
      last_filing_year: lastYear,
      exemplar_filing_uuid: exemplar?.filing_uuid ?? null,
      exemplar_filing_url: exemplar ? filingHumanUrl(exemplar) : null,
    },
    usaspending: {
      recipient_query: recipientQuery,
      awards_returned: awards.length,
      total_award_amount: totalAward,
      by_year: [...byYear.entries()]
        .sort(([a], [b]) => a - b)
        .map(([year, v]) => ({ year, total: v.total, award_count: v.count })),
      top_agencies: [...byAgency.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 10)
        .map(([agency, v]) => ({ agency, total: v.total, award_count: v.count })),
      top_awards: topAwards,
    },
    derived: {
      contracts_per_dollar_lobbied: ratio,
      label: "derived ratio; does not imply causation",
    },
  };

  const citations = buildCitations(data);
  const entity: EntityId = {
    kind: "client",
    id: String(client_id),
    display: client_name,
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

function buildCitations(data: ContractTraceData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();
  if (data.lda.exemplar_filing_url) {
    cites.push({
      key: "lda_total",
      description: `LDA lobbying total ${data.window.year_start}–${data.window.year_end}`,
      source: "lda",
      url: data.lda.exemplar_filing_url,
      source_id: data.lda.exemplar_filing_uuid ?? undefined,
      fetched_at,
    });
  }
  if (data.usaspending.top_awards.length > 0) {
    cites.push({
      key: "usa_top",
      description: `USASpending top contract award to ${data.client.name}`,
      source: "usaspending",
      url: data.usaspending.top_awards[0]!.human_url,
      source_id: data.usaspending.top_awards[0]!.generated_internal_id ?? undefined,
      fetched_at,
    });
  }
  // One citation per year bin with awards
  for (const y of data.usaspending.by_year) {
    const exemplarForYear = data.usaspending.top_awards.find((a) => {
      const yr = a.start_date ? Number.parseInt(a.start_date.slice(0, 4), 10) : null;
      return yr === y.year;
    });
    if (exemplarForYear) {
      cites.push({
        key: `usa_${y.year}`,
        description: `USASpending awards in ${y.year} (${y.award_count} × ${fmtUsd(y.total)})`,
        source: "usaspending",
        url: exemplarForYear.human_url,
        source_id: exemplarForYear.generated_internal_id ?? undefined,
        fetched_at,
      });
    }
  }
  return cites;
}

function renderMarkdown(data: ContractTraceData): string {
  const lines: string[] = [];
  lines.push(`## ${data.client.name} — Lobbying-to-Contracts Trace`);
  lines.push("");
  lines.push(`Window: ${data.window.year_start}–${data.window.year_end}.`);
  lines.push("");
  lines.push(
    `- **LDA lobbying spend:** ${fmtUsd(data.lda.total_lobbying_spend)} across ${data.lda.filings} ${plural("filing", data.lda.filings)} [lda_total].`,
  );
  lines.push(
    `- **USASpending contract awards:** ${fmtUsd(data.usaspending.total_award_amount)} across ${data.usaspending.awards_returned} awards${data.usaspending.top_awards.length > 0 ? " [usa_top]" : ""}.`,
  );
  if (data.derived.contracts_per_dollar_lobbied !== null) {
    lines.push(
      `- **Derived ratio:** ${data.derived.contracts_per_dollar_lobbied.toFixed(2)}× (${fmtUsd(data.usaspending.total_award_amount)} in contracts per ${fmtUsd(data.lda.total_lobbying_spend)} in reported lobbying). _Derived; does not imply causation._`,
    );
  }

  if (data.usaspending.by_year.length > 0) {
    lines.push("");
    lines.push("### Awards by year");
    lines.push("");
    lines.push("| Year | Awards | Total |");
    lines.push("| ---- | ------ | ----- |");
    for (const y of data.usaspending.by_year) {
      const cite = data.usaspending.top_awards.some((a) =>
        a.start_date?.startsWith(String(y.year)),
      )
        ? ` [usa_${y.year}]`
        : "";
      lines.push(`| ${y.year} | ${y.award_count} | ${fmtUsd(y.total)}${cite} |`);
    }
  }

  if (data.usaspending.top_agencies.length > 0) {
    lines.push("");
    lines.push("### Top awarding agencies");
    lines.push("");
    for (const a of data.usaspending.top_agencies.slice(0, 5)) {
      lines.push(`- **${a.agency}** — ${fmtUsd(a.total)} across ${a.award_count} ${plural("award", a.award_count)}.`);
    }
  }

  if (data.usaspending.top_awards.length > 0) {
    lines.push("");
    lines.push("### Top individual awards");
    lines.push("");
    for (const a of data.usaspending.top_awards.slice(0, 10)) {
      const date =
        a.start_date && a.end_date ? ` (${a.start_date} → ${a.end_date})` : "";
      const desc = a.description ? ` — ${truncate(a.description, 140)}` : "";
      lines.push(`- [${fmtUsd(a.amount)}](${a.human_url}) ${a.agency ?? "(agency unknown)"}${date}${desc}`);
    }
  }

  lines.push("");
  lines.push(
    "> Co-occurrence, not causation. Federal contracts awarded to a lobbying client are NOT proof that lobbying caused them. Agencies award contracts on statutory criteria; the tool reports the overlap only.",
  );
  return lines.join("\n");
}

function plural(w: string, n: number): string {
  return n === 1 ? w : `${w}s`;
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
