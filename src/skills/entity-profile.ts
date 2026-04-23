/**
 * entity-profile — the first skill.
 *
 * Given a client (by name or LDA client_id) and a year range, produces a
 * Brief with:
 *   - total filed spend (income or expenses, per filing)
 *   - quarterly filings count and year-by-year coverage
 *   - unique lobbying firms (registrants) employed
 *   - unique individual lobbyists who touched any filing
 *   - top general issue codes (HCR, TAX, TRD, ...)
 *   - top covered government entities (House, Senate, specific agencies)
 *
 * Every figure cites the underlying LDA filing. Narrative is derivative of
 * the structured envelope; the envelope is the contract.
 *
 * This skill is a pure function over the LDA client + DB. Persisting the
 * brief to memory is the caller's job (CLI or MCP server).
 */

import type { LdaClient } from "../core/lda-client.ts";
import {
  listFilingsForClient,
  filingSpend,
  filingQuarter,
  filingHumanUrl,
  type Filing,
} from "../core/lda-endpoints.ts";
import type { DbClient } from "../db/engine.ts";
import { upsertFilingsBatch } from "../db/repos.ts";
import { resolveClient } from "../core/resolve.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";
import { fmtUsd } from "../core/types.ts";

export const SKILL_NAME = "entity-profile";
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface EntityProfileInput {
  /** Free-text client name. One of this or client_id is required. */
  client?: string;
  /** LDA client_id (skip resolution if provided). */
  client_id?: number;
  /** Inclusive year range. Defaults to cfg.default_year_start..default_year_end if omitted. */
  year_start: number;
  year_end: number;
  /** Optional quarter filter. */
  quarter?: 1 | 2 | 3 | 4;
}

export interface EntityProfileData {
  client: {
    client_id: number;
    name: string;
    state: string | null;
    country: string | null;
    government_entity: boolean | null;
  };
  window: TimeWindow;
  totals: {
    filings: number;
    total_spend: number;        // sum of filingSpend across all filings in window
    quarters_with_activity: number;
    first_filing_year: number | null;
    last_filing_year: number | null;
  };
  spend_by_year: Array<{ year: number; spend: number; filings: number }>;
  spend_by_quarter: Array<{
    year: number;
    quarter: 1 | 2 | 3 | 4;
    spend: number;
    filing_uuid: string | null;
  }>;
  top_registrants: Array<{
    registrant_id: number;
    registrant_name: string;
    filings: number;
    total_spend: number;        // subset of filings where this registrant was the one filing
  }>;
  top_lobbyists: Array<{
    lobbyist_id: number;
    name: string;
    filings_touched: number;
    new_registration_flags: number;  // how many times this lobbyist appeared as newly registered
  }>;
  top_issue_codes: Array<{
    code: string;
    display: string;
    filings: number;
  }>;
  top_government_entities: Array<{
    name: string;
    filings: number;
  }>;
}

// ---------------------------------------------------------------------------
// Skill implementation
// ---------------------------------------------------------------------------

export async function runEntityProfile(
  lda: LdaClient,
  db: DbClient,
  input: EntityProfileInput,
): Promise<Brief<EntityProfileData>> {
  // 1. Resolve the client
  let client_id = input.client_id;
  let client_name: string;
  let client_meta: { state: string | null; country: string | null; government_entity: boolean | null } = {
    state: null,
    country: null,
    government_entity: null,
  };

  if (client_id === undefined) {
    if (!input.client) {
      throw new Error("entity-profile requires either `client` (name) or `client_id`.");
    }
    const resolved = await resolveClient(db, lda, input.client);
    if (!resolved) {
      throw new Error(
        `entity-profile: no LDA client matched "${input.client}". Try a broader name or provide --client-id.`,
      );
    }
    client_id = resolved.client_id;
    client_name = resolved.name;
  } else {
    client_name = `client #${client_id}`;
  }

  // 2. Fetch filings, mirror into DB.
  //
  // Query by client_name (substring). Use the USER'S input rather than the
  // LDA-resolved canonical, because any given canonical is just one of
  // dozens of variants — some with filer-introduced typos
  // ("LOCKHEED MARTIN CORPORORATION"). The user's input captures intent
  // most cleanly. If the caller passed client_id, honor it precisely.
  const filings = input.client_id !== undefined
    ? await listFilingsForClient(lda, {
        clientId: input.client_id,
        yearStart: input.year_start,
        yearEnd: input.year_end,
        quarter: input.quarter,
      })
    : await listFilingsForClient(lda, {
        clientName: input.client!,
        yearStart: input.year_start,
        yearEnd: input.year_end,
        quarter: input.quarter,
      });
  await upsertFilingsBatch(db, filings);

  // Refine client_name from the freshest filing if we hadn't resolved it above.
  const firstFiling = filings[0];
  if (firstFiling) {
    client_name = firstFiling.client.name;
    client_meta = {
      state: firstFiling.client.state ?? null,
      country: firstFiling.client.country ?? null,
      government_entity: firstFiling.client.client_government_entity ?? null,
    };
  }

  // 3. Aggregate
  const data = aggregateFilings(
    filings,
    client_id,
    client_name,
    client_meta,
    { year_start: input.year_start, year_end: input.year_end, quarter: input.quarter },
  );

  // 4. Citations
  const citations = buildCitations(filings, data);

  // 5. Narrative
  const window: TimeWindow = {
    year_start: input.year_start,
    year_end: input.year_end,
    quarter: input.quarter,
  };
  const markdown = renderMarkdown(data, window);

  const entity: EntityId = {
    kind: "client",
    id: String(client_id),
    display: client_name,
  };

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
// Aggregation
// ---------------------------------------------------------------------------

function aggregateFilings(
  filings: Filing[],
  client_id: number,
  client_name: string,
  client_meta: { state: string | null; country: string | null; government_entity: boolean | null },
  window: TimeWindow,
): EntityProfileData {
  const spend_by_year = new Map<number, { spend: number; filings: number }>();
  const spend_by_quarter: EntityProfileData["spend_by_quarter"] = [];
  const registrants = new Map<number, { registrant_name: string; filings: number; total_spend: number }>();
  const lobbyists = new Map<number, { name: string; filings_touched: number; new_registration_flags: number }>();
  const issue_codes = new Map<string, { display: string; filings: number }>();
  const govt_entities = new Map<string, { filings: number }>();

  let total_spend = 0;
  let total_filings = 0;
  let first_year: number | null = null;
  let last_year: number | null = null;
  const active_quarters = new Set<string>();

  for (const f of filings) {
    total_filings += 1;
    const spend = filingSpend(f) ?? 0;
    total_spend += spend;

    if (first_year === null || f.filing_year < first_year) first_year = f.filing_year;
    if (last_year === null || f.filing_year > last_year) last_year = f.filing_year;

    // Year aggregate
    const yagg = spend_by_year.get(f.filing_year) ?? { spend: 0, filings: 0 };
    yagg.spend += spend;
    yagg.filings += 1;
    spend_by_year.set(f.filing_year, yagg);

    // Quarter (LD-2 only; LD-203 mid/year-end filings won't have a quarter)
    const q = filingQuarter(f);
    if (q) {
      active_quarters.add(`${f.filing_year}-${q}`);
      spend_by_quarter.push({
        year: f.filing_year,
        quarter: q,
        spend,
        filing_uuid: f.filing_uuid,
      });
    }

    // Registrant
    const reg = registrants.get(f.registrant.id) ?? {
      registrant_name: f.registrant.name,
      filings: 0,
      total_spend: 0,
    };
    reg.filings += 1;
    reg.total_spend += spend;
    registrants.set(f.registrant.id, reg);

    // Lobbyists + issues + govt entities
    for (const act of f.lobbying_activities ?? []) {
      if (act.general_issue_code) {
        const icode = act.general_issue_code;
        const ientry = issue_codes.get(icode) ?? {
          display: act.general_issue_code_display ?? icode,
          filings: 0,
        };
        ientry.filings += 1;
        issue_codes.set(icode, ientry);
      }
      for (const ge of act.government_entities ?? []) {
        const gentry = govt_entities.get(ge.name) ?? { filings: 0 };
        gentry.filings += 1;
        govt_entities.set(ge.name, gentry);
      }
      for (const la of act.lobbyists ?? []) {
        const lid = la.lobbyist.id;
        const name = [la.lobbyist.first_name, la.lobbyist.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || `lobbyist #${lid}`;
        const lentry = lobbyists.get(lid) ?? {
          name,
          filings_touched: 0,
          new_registration_flags: 0,
        };
        lentry.filings_touched += 1;
        if (la.new) lentry.new_registration_flags += 1;
        lobbyists.set(lid, lentry);
      }
    }
  }

  // Sort the time series by (year, quarter)
  spend_by_quarter.sort((a, b) => a.year - b.year || a.quarter - b.quarter);

  return {
    client: {
      client_id,
      name: client_name,
      state: client_meta.state,
      country: client_meta.country,
      government_entity: client_meta.government_entity,
    },
    window,
    totals: {
      filings: total_filings,
      total_spend,
      quarters_with_activity: active_quarters.size,
      first_filing_year: first_year,
      last_filing_year: last_year,
    },
    spend_by_year: [...spend_by_year.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, v]) => ({ year, spend: v.spend, filings: v.filings })),
    spend_by_quarter,
    top_registrants: [...registrants.entries()]
      .sort((a, b) => b[1].total_spend - a[1].total_spend || b[1].filings - a[1].filings)
      .slice(0, 10)
      .map(([id, v]) => ({
        registrant_id: id,
        registrant_name: v.registrant_name,
        filings: v.filings,
        total_spend: v.total_spend,
      })),
    top_lobbyists: [...lobbyists.entries()]
      .sort((a, b) => b[1].filings_touched - a[1].filings_touched)
      .slice(0, 10)
      .map(([id, v]) => ({
        lobbyist_id: id,
        name: v.name,
        filings_touched: v.filings_touched,
        new_registration_flags: v.new_registration_flags,
      })),
    top_issue_codes: [...issue_codes.entries()]
      .sort((a, b) => b[1].filings - a[1].filings)
      .slice(0, 10)
      .map(([code, v]) => ({ code, display: v.display, filings: v.filings })),
    top_government_entities: [...govt_entities.entries()]
      .sort((a, b) => b[1].filings - a[1].filings)
      .slice(0, 10)
      .map(([name, v]) => ({ name, filings: v.filings })),
  };
}

// ---------------------------------------------------------------------------
// Citations + narrative
// ---------------------------------------------------------------------------

function buildCitations(filings: Filing[], data: EntityProfileData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();

  // Cite the underlying filing for total spend — pick the most recent filing
  // as the headline link. Readers who want every filing can use --format=json.
  if (filings[0]) {
    cites.push({
      key: "total_spend",
      description: `Filed lobbying spend, ${data.window.year_start}–${data.window.year_end}`,
      source: "lda",
      url: filingHumanUrl(filings[0]),
      source_id: filings[0].filing_uuid,
      fetched_at,
    });
  }

  // Cite each annual total against that year's first filing.
  for (const yr of data.spend_by_year) {
    const exemplar = filings.find((f) => f.filing_year === yr.year);
    if (!exemplar) continue;
    cites.push({
      key: `year_${yr.year}`,
      description: `Filed spend for ${yr.year} (${yr.filings} filings, ${fmtUsd(yr.spend)})`,
      source: "lda",
      url: filingHumanUrl(exemplar),
      source_id: exemplar.filing_uuid,
      fetched_at,
    });
  }

  return cites;
}

function renderMarkdown(data: EntityProfileData, window: TimeWindow): string {
  const { client, totals } = data;
  const q = window.quarter ? ` (Q${window.quarter} only)` : "";
  const years = `${window.year_start}–${window.year_end}${q}`;
  const headline =
    totals.filings === 0
      ? `No LDA filings recorded for ${client.name} in ${years}.`
      : `${client.name} filed ${totals.filings} LDA ${pluralize("filing", totals.filings)} covering ${years}, with ${fmtUsd(totals.total_spend)} in reported lobbying spend [total_spend].`;

  const lines: string[] = [];
  lines.push(`## ${client.name} — Lobbying Profile`);
  lines.push("");
  lines.push(headline);
  if (totals.filings > 0) {
    if (totals.first_filing_year !== null && totals.last_filing_year !== null) {
      lines.push(
        `- Activity window: ${totals.first_filing_year} → ${totals.last_filing_year} (${totals.quarters_with_activity} active quarters).`,
      );
    }
    if (client.state) {
      lines.push(
        `- Registered address: ${client.state}${client.country && client.country !== "USA" ? ", " + client.country : ""}.`,
      );
    }
    if (client.government_entity === true) {
      lines.push(`- Filer is a government entity (per LDA classification).`);
    }

    // Year-by-year table
    if (data.spend_by_year.length > 0) {
      lines.push("");
      lines.push("### Spend by year");
      lines.push("");
      lines.push("| Year | Filings | Reported spend |");
      lines.push("| ---- | ------- | -------------- |");
      for (const y of data.spend_by_year) {
        lines.push(`| ${y.year} | ${y.filings} | ${fmtUsd(y.spend)} [year_${y.year}] |`);
      }
    }

    // Top registrants
    if (data.top_registrants.length > 0) {
      lines.push("");
      lines.push("### Lobbying firms employed (top 5 by filings)");
      lines.push("");
      for (const r of data.top_registrants.slice(0, 5)) {
        lines.push(
          `- **${r.registrant_name}** — ${r.filings} ${pluralize("filing", r.filings)}, ${fmtUsd(r.total_spend)} reported.`,
        );
      }
    }

    // Top lobbyists
    if (data.top_lobbyists.length > 0) {
      lines.push("");
      lines.push("### Individual lobbyists (top 5 by filings touched)");
      lines.push("");
      for (const l of data.top_lobbyists.slice(0, 5)) {
        const newFlag =
          l.new_registration_flags > 0
            ? ` _(newly registered in ${l.new_registration_flags} ${pluralize("filing", l.new_registration_flags)})_`
            : "";
        lines.push(`- ${l.name} — touched ${l.filings_touched} ${pluralize("filing", l.filings_touched)}.${newFlag}`);
      }
    }

    // Top issue codes
    if (data.top_issue_codes.length > 0) {
      lines.push("");
      lines.push("### Issues lobbied (top 5 by filing count)");
      lines.push("");
      for (const i of data.top_issue_codes.slice(0, 5)) {
        lines.push(`- **${i.code}** — ${i.display} (${i.filings} ${pluralize("filing", i.filings)}).`);
      }
    }

    // Top government entities
    if (data.top_government_entities.length > 0) {
      lines.push("");
      lines.push("### Government entities contacted (top 5)");
      lines.push("");
      for (const g of data.top_government_entities.slice(0, 5)) {
        lines.push(`- ${g.name} (${g.filings} ${pluralize("filing", g.filings)}).`);
      }
    }
  }

  lines.push("");
  lines.push(
    "> Filed facts only. Every figure cites a Senate LDA filing. The tool cannot detect unregistered lobbying.",
  );
  return lines.join("\n");
}

function pluralize(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}
