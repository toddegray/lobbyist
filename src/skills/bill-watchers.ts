/**
 * bill-watchers — given a bill cite or issue area, who's lobbying on it?
 *
 * Two modes:
 *
 *   1. `bill`: a free-text substring (e.g. "HR 5376", "CHIPS Act", "FY2024
 *      NDAA"). LDA's free-text issue field is where lobbyists describe the
 *      specific bills they're working; we match server-side on
 *      `filing_specific_lobbying_issues`.
 *
 *   2. `issue_code`: an LDA general issue code (e.g. "HCR" = Health,
 *      "TAX" = Taxation). Server-side exact match on
 *      `filing_general_issue_code`.
 *
 * Output is a ranked list of clients lobbying on the issue, plus the firms
 * they hired and their reported spend. Every client links to a representative
 * filing.
 *
 * Pure function; caller persists the brief.
 */

import type { LdaClient } from "../core/lda-client.ts";
import {
  listFilingsByIssueCode,
  listFilingsByIssueSubstring,
  filingSpend,
  filingHumanUrl,
  type Filing,
} from "../core/lda-endpoints.ts";
import type { DbClient } from "../db/engine.ts";
import { upsertFilingsBatch } from "../db/repos.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";
import { fmtUsd } from "../core/types.ts";
import { createHash } from "node:crypto";

export const SKILL_NAME = "bill-watchers";
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface BillWatchersInput {
  /** Free-text substring matched against filings' specific-lobbying-issues. */
  bill?: string;
  /** LDA general issue code (e.g. "HCR"). One of this or `bill` is required. */
  issue_code?: string;
  year_start: number;
  year_end: number;
  quarter?: 1 | 2 | 3 | 4;
}

export interface BillWatchersData {
  query: { bill: string | null; issue_code: string | null };
  window: TimeWindow;
  totals: {
    filings: number;
    unique_clients: number;
    unique_registrants: number;
    reported_spend_sum: number;   // labeled 'sum' not 'total' because filings double-count when a single client hires multiple firms
  };
  top_clients: Array<{
    client_id: number;
    client_name: string;
    filings: number;
    reported_spend: number;
    primary_registrants: string[];    // up to 3
    exemplar_filing_uuid: string;
    exemplar_filing_url: string;
  }>;
  top_registrants: Array<{
    registrant_id: number;
    registrant_name: string;
    filings: number;
    client_count: number;
  }>;
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export async function runBillWatchers(
  lda: LdaClient,
  db: DbClient,
  input: BillWatchersInput,
): Promise<Brief<BillWatchersData>> {
  if (!input.bill && !input.issue_code) {
    throw new Error("bill-watchers requires either `bill` (substring) or `issue_code`.");
  }

  const filings: Filing[] = input.issue_code
    ? await listFilingsByIssueCode(lda, {
        issueCode: input.issue_code,
        yearStart: input.year_start,
        yearEnd: input.year_end,
      })
    : await listFilingsByIssueSubstring(lda, {
        issueSubstring: input.bill!,
        yearStart: input.year_start,
        yearEnd: input.year_end,
      });

  await upsertFilingsBatch(db, filings);

  // Client-side narrowing on quarter if asked (server doesn't index cleanly on
  // all dimensions at once).
  const narrowed = input.quarter
    ? filings.filter((f) => {
        const p = (f.filing_period || "").toLowerCase();
        const q = ["first", "second", "third", "fourth"][input.quarter! - 1] ?? "";
        return q !== "" && p.startsWith(q);
      })
    : filings;

  const data = aggregate(narrowed, input);
  const citations = buildCitations(narrowed, data);
  const window: TimeWindow = {
    year_start: input.year_start,
    year_end: input.year_end,
    quarter: input.quarter,
  };

  // We key the brief on a synthesized entity because the target is an
  // abstract topic, not a concrete LDA client. Entity kind is "issue" with
  // a hash of the query.
  const queryKey = input.issue_code
    ? `code:${input.issue_code}`
    : `bill:${input.bill}`;
  const hash = createHash("sha256").update(queryKey.toUpperCase()).digest("hex").slice(0, 12);
  const entity: EntityId = {
    kind: "issue",
    id: hash,
    display: input.issue_code ?? input.bill!,
  };

  const markdown = renderMarkdown(data, window);

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    entity,
    window,
    generated_at: new Date().toISOString(),
    data,
    citations,
    markdown,
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

function aggregate(filings: Filing[], input: BillWatchersInput): BillWatchersData {
  const clients = new Map<
    number,
    {
      client_name: string;
      filings: number;
      reported_spend: number;
      registrant_set: Map<string, number>;
      exemplar: Filing;
    }
  >();
  const registrants = new Map<
    number,
    { registrant_name: string; filings: number; client_set: Set<number> }
  >();

  let totalSpend = 0;

  for (const f of filings) {
    const spend = filingSpend(f) ?? 0;
    totalSpend += spend;

    const cid = f.client.id;
    const cObj = clients.get(cid) ?? {
      client_name: f.client.name,
      filings: 0,
      reported_spend: 0,
      registrant_set: new Map<string, number>(),
      exemplar: f,
    };
    cObj.filings += 1;
    cObj.reported_spend += spend;
    cObj.registrant_set.set(
      f.registrant.name,
      (cObj.registrant_set.get(f.registrant.name) ?? 0) + 1,
    );
    clients.set(cid, cObj);

    const rid = f.registrant.id;
    const rObj = registrants.get(rid) ?? {
      registrant_name: f.registrant.name,
      filings: 0,
      client_set: new Set<number>(),
    };
    rObj.filings += 1;
    rObj.client_set.add(cid);
    registrants.set(rid, rObj);
  }

  return {
    query: {
      bill: input.bill ?? null,
      issue_code: input.issue_code ?? null,
    },
    window: { year_start: input.year_start, year_end: input.year_end, quarter: input.quarter },
    totals: {
      filings: filings.length,
      unique_clients: clients.size,
      unique_registrants: registrants.size,
      reported_spend_sum: totalSpend,
    },
    top_clients: [...clients.entries()]
      .sort((a, b) => b[1].reported_spend - a[1].reported_spend || b[1].filings - a[1].filings)
      .slice(0, 25)
      .map(([cid, v]) => ({
        client_id: cid,
        client_name: v.client_name,
        filings: v.filings,
        reported_spend: v.reported_spend,
        primary_registrants: [...v.registrant_set.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name]) => name),
        exemplar_filing_uuid: v.exemplar.filing_uuid,
        exemplar_filing_url: filingHumanUrl(v.exemplar),
      })),
    top_registrants: [...registrants.entries()]
      .sort((a, b) => b[1].filings - a[1].filings)
      .slice(0, 15)
      .map(([rid, v]) => ({
        registrant_id: rid,
        registrant_name: v.registrant_name,
        filings: v.filings,
        client_count: v.client_set.size,
      })),
  };
}

// ---------------------------------------------------------------------------
// Citations + narrative
// ---------------------------------------------------------------------------

function buildCitations(filings: Filing[], data: BillWatchersData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();
  for (const c of data.top_clients.slice(0, 10)) {
    cites.push({
      key: `client_${c.client_id}`,
      description: `Lobbying activity by ${c.client_name} on ${data.query.bill ?? data.query.issue_code}`,
      source: "lda",
      url: c.exemplar_filing_url,
      source_id: c.exemplar_filing_uuid,
      fetched_at,
    });
  }
  return cites;
}

function renderMarkdown(data: BillWatchersData, window: TimeWindow): string {
  const q = window.quarter ? ` (Q${window.quarter} only)` : "";
  const years = `${window.year_start}–${window.year_end}${q}`;
  const target = data.query.issue_code
    ? `issue code **${data.query.issue_code}**`
    : `bill / topic "**${data.query.bill}**"`;

  const lines: string[] = [];
  lines.push(`## Who's lobbying on ${target}?`);
  lines.push("");
  if (data.totals.filings === 0) {
    lines.push(`No LDA filings matched ${target} in ${years}.`);
    return lines.join("\n");
  }

  lines.push(
    `In ${years}, **${data.totals.unique_clients}** ${pluralize("client", data.totals.unique_clients)} ` +
      `hired **${data.totals.unique_registrants}** ${pluralize("firm", data.totals.unique_registrants)} ` +
      `across **${data.totals.filings}** ${pluralize("filing", data.totals.filings)}, ` +
      `with ${fmtUsd(data.totals.reported_spend_sum)} in total reported spend ` +
      `(filings double-count when a client hires multiple firms).`,
  );

  if (data.top_clients.length > 0) {
    lines.push("");
    lines.push("### Top clients by reported spend");
    lines.push("");
    lines.push("| Client | Filings | Reported spend | Firms hired |");
    lines.push("| ------ | ------- | -------------- | ----------- |");
    for (const c of data.top_clients.slice(0, 15)) {
      const firms = c.primary_registrants.join(", ") || "—";
      lines.push(
        `| **${c.client_name}** [client_${c.client_id}] | ${c.filings} | ${fmtUsd(c.reported_spend)} | ${firms} |`,
      );
    }
  }

  if (data.top_registrants.length > 0) {
    lines.push("");
    lines.push("### Most active lobbying firms on this topic");
    lines.push("");
    for (const r of data.top_registrants.slice(0, 10)) {
      lines.push(
        `- **${r.registrant_name}** — ${r.filings} ${pluralize("filing", r.filings)} across ${r.client_count} ${pluralize("client", r.client_count)}.`,
      );
    }
  }

  lines.push("");
  lines.push(
    "> Filed facts only. Shadow lobbying, coalition work outside registered channels, and grasstops advocacy are not captured.",
  );
  return lines.join("\n");
}

function pluralize(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}
