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
import type { CongressClient } from "../core/congress-client.ts";
import {
  listFilingsByIssueCode,
  listFilingsByIssueSubstring,
  filingSpend,
  filingHumanUrl,
  type Filing,
} from "../core/lda-endpoints.ts";
import {
  getBill,
  getBillCommittees,
  billHumanUrl,
  sponsorShortLabel,
  type Bill,
  type BillCommittee,
} from "../core/congress-endpoints.ts";
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
  /** LDA general issue code (e.g. "HCR"). One of bill, issue_code, or congress_bill is required. */
  issue_code?: string;
  /**
   * Exact Congress.gov bill reference as {congress, type, number}. When
   * provided, the skill fetches the bill's official title, sponsor, and
   * committees of jurisdiction from Congress.gov and enriches the brief.
   * If `bill` is also provided, that remains the LDA substring; if not,
   * we fall back to substring-matching on the official bill title.
   * Requires a configured Congress.gov client.
   */
  congress_bill?: {
    congress: number;
    type: string;       // "HR" | "S" | "HJRES" | "SJRES" | "HCONRES" | "SCONRES" | "HRES" | "SRES"
    number: string | number;
  };
  year_start: number;
  year_end: number;
  quarter?: 1 | 2 | 3 | 4;
}

export interface BillMetadata {
  congress: number;
  type: string;
  number: string;
  title: string | null;
  short_label: string;                  // e.g. "H.R. 4346 (117th)"
  human_url: string;
  introduced_date: string | null;
  latest_action: string | null;
  latest_action_date: string | null;
  sponsor: {
    bioguide_id: string;
    full_name: string | null;
    party: string | null;
    state: string | null;
    label: string;
  } | null;
  committees_of_jurisdiction: Array<{
    chamber: string;
    name: string;
    system_code: string;
    type: string | null;
  }>;
}

export interface BillWatchersData {
  query: {
    bill: string | null;
    issue_code: string | null;
    congress_bill: { congress: number; type: string; number: string } | null;
  };
  /** Congress.gov bill metadata, if a congress_bill reference was provided. */
  bill_metadata: BillMetadata | null;
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
  congress?: CongressClient | null,
): Promise<Brief<BillWatchersData>> {
  if (!input.bill && !input.issue_code && !input.congress_bill) {
    throw new Error("bill-watchers requires `bill`, `issue_code`, or `congress_bill`.");
  }

  // 1. If a congress_bill reference was supplied, fetch metadata from
  //    Congress.gov. Best-effort: if the Congress.gov call fails we degrade
  //    to substring-only behavior rather than failing the whole skill.
  let bill_metadata: BillMetadata | null = null;
  if (input.congress_bill && congress) {
    try {
      const [bill, committees] = await Promise.all([
        getBill(congress, input.congress_bill),
        getBillCommittees(congress, input.congress_bill),
      ]);
      bill_metadata = buildBillMetadata(bill, committees, input.congress_bill);
    } catch (e) {
      // Non-fatal — surface on stderr so the user knows enrichment skipped.
      process.stderr.write(
        `[bill-watchers] Congress.gov lookup failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // 2. Decide what substring to search LDA with. Preference order:
  //    a. Explicit --bill free-text (user's words)
  //    b. Bill's official Congress.gov title (fetched above)
  //    c. None — use issue_code exclusively.
  const ldaSubstring =
    input.bill ?? bill_metadata?.title ?? null;

  // 3. Query LDA.
  let filings: Filing[];
  if (input.issue_code) {
    filings = await listFilingsByIssueCode(lda, {
      issueCode: input.issue_code,
      yearStart: input.year_start,
      yearEnd: input.year_end,
    });
  } else if (ldaSubstring) {
    filings = await listFilingsByIssueSubstring(lda, {
      issueSubstring: ldaSubstring,
      yearStart: input.year_start,
      yearEnd: input.year_end,
    });
  } else {
    // Shouldn't reach: we validated at the top that one of bill / issue_code
    // / congress_bill was provided. congress_bill alone without a successful
    // metadata fetch means we have no substring to search with.
    throw new Error(
      "bill-watchers: Congress.gov lookup didn't return a usable title; provide --bill=\"<substring>\" as well.",
    );
  }

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

  const data = aggregate(narrowed, input, bill_metadata);
  const citations = buildCitations(narrowed, data);
  const window: TimeWindow = {
    year_start: input.year_start,
    year_end: input.year_end,
    quarter: input.quarter,
  };

  // We key the brief on a synthesized entity because the target is an
  // abstract topic, not a concrete LDA client. Prefer the Congress.gov
  // bill ID when supplied (stable + unique); otherwise hash the query.
  const entity: EntityId = bill_metadata
    ? {
        kind: "bill",
        id: `${bill_metadata.congress}-${bill_metadata.type}-${bill_metadata.number}`,
        display: bill_metadata.short_label,
      }
    : (() => {
        const queryKey = input.issue_code
          ? `code:${input.issue_code}`
          : `bill:${input.bill}`;
        const hash = createHash("sha256").update(queryKey.toUpperCase()).digest("hex").slice(0, 12);
        return {
          kind: "issue" as const,
          id: hash,
          display: input.issue_code ?? input.bill!,
        };
      })();

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

function buildBillMetadata(
  bill: Bill,
  committees: BillCommittee[],
  ref: { congress: number; type: string; number: string | number },
): BillMetadata {
  const congress = bill.congress ?? ref.congress;
  const type = (bill.type ?? ref.type).toUpperCase();
  const number = String(bill.number ?? ref.number);
  const short_label = `${formatBillType(type)} ${number} (${congress}th)`;
  const sponsor = bill.sponsors[0];
  const latest = bill.latestAction;
  return {
    congress,
    type,
    number,
    title: bill.title ?? null,
    short_label,
    human_url: billHumanUrl(congress, type, number),
    introduced_date: bill.introducedDate ?? null,
    latest_action: latest?.text ?? null,
    latest_action_date: latest?.actionDate ?? null,
    sponsor: sponsor
      ? {
          bioguide_id: sponsor.bioguideId,
          full_name: sponsor.fullName ?? null,
          party: sponsor.party ?? null,
          state: sponsor.state ?? null,
          label: sponsorShortLabel(sponsor),
        }
      : null,
    committees_of_jurisdiction: committees.map((c) => ({
      chamber: c.chamber,
      name: c.name,
      system_code: c.systemCode,
      type: c.type ?? null,
    })),
  };
}

function formatBillType(type: string): string {
  // "HR" → "H.R.", "S" → "S.", "HJRES" → "H.J.Res.", etc.
  const upper = type.toUpperCase();
  switch (upper) {
    case "HR":
      return "H.R.";
    case "S":
      return "S.";
    case "HJRES":
      return "H.J.Res.";
    case "SJRES":
      return "S.J.Res.";
    case "HCONRES":
      return "H.Con.Res.";
    case "SCONRES":
      return "S.Con.Res.";
    case "HRES":
      return "H.Res.";
    case "SRES":
      return "S.Res.";
    default:
      return upper;
  }
}

function aggregate(
  filings: Filing[],
  input: BillWatchersInput,
  bill_metadata: BillMetadata | null,
): BillWatchersData {
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
      congress_bill: input.congress_bill
        ? {
            congress: input.congress_bill.congress,
            type: input.congress_bill.type.toUpperCase(),
            number: String(input.congress_bill.number),
          }
        : null,
    },
    bill_metadata,
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

  if (data.bill_metadata) {
    cites.push({
      key: "bill_congress",
      description: `Congress.gov record for ${data.bill_metadata.short_label}`,
      source: "congress",
      url: data.bill_metadata.human_url,
      source_id: `${data.bill_metadata.congress}-${data.bill_metadata.type}-${data.bill_metadata.number}`,
      fetched_at,
    });
  }
  for (const c of data.top_clients.slice(0, 10)) {
    const target =
      data.bill_metadata?.short_label ??
      data.query.bill ??
      data.query.issue_code ??
      "(target)";
    cites.push({
      key: `client_${c.client_id}`,
      description: `Lobbying activity by ${c.client_name} on ${target}`,
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
  const target = data.bill_metadata
    ? `**${data.bill_metadata.short_label}**`
    : data.query.issue_code
      ? `issue code **${data.query.issue_code}**`
      : `bill / topic "**${data.query.bill}**"`;

  const lines: string[] = [];
  lines.push(`## Who's lobbying on ${target}?`);
  lines.push("");

  // Bill-metadata section (Congress.gov enrichment)
  if (data.bill_metadata) {
    const m = data.bill_metadata;
    if (m.title) {
      lines.push(`**Title:** ${m.title} [bill_congress]`);
      lines.push("");
    }
    const meta: string[] = [];
    if (m.introduced_date) meta.push(`introduced ${m.introduced_date}`);
    if (m.sponsor) meta.push(`sponsored by ${m.sponsor.label}`);
    if (m.latest_action) {
      meta.push(
        `latest action: ${m.latest_action}${m.latest_action_date ? ` (${m.latest_action_date})` : ""}`,
      );
    }
    if (meta.length) {
      lines.push(`- ${meta.join("  \n- ")}`);
    }
    if (m.committees_of_jurisdiction.length > 0) {
      lines.push("");
      lines.push("**Committees of jurisdiction:**");
      for (const c of m.committees_of_jurisdiction) {
        lines.push(`- ${c.chamber} — ${c.name} (${c.system_code})`);
      }
    }
    lines.push("");
  }

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
