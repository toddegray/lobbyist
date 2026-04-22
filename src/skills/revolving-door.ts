/**
 * revolving-door — given an individual lobbyist, what's their career arc?
 *
 * We take a person name (or an LDA lobbyist_id), then:
 *   1. Resolve to an lda lobbyist record via /lobbyists/?lobbyist_name=…
 *   2. List every filing they appear on via /filings/?lobbyist_id=…
 *   3. Extract:
 *        - covered positions (e.g. "Chief of Staff, Senator Jones (2015–2019)")
 *        - clients lobbied for, with date ranges
 *        - registrants (firms employing them)
 *        - issue codes touched
 *
 * What we CAN say:
 *   - "This lobbyist disclosed covered positions X, Y, Z in filings."
 *   - "They lobbied for clients A, B, C between these dates."
 *   - "They've been employed by registrants R1, R2, R3."
 *
 * What we CANNOT say:
 *   - "They left a government job three months before registering" — the
 *     LDA doesn't give us the government exit date, only the covered-position
 *     text. We surface the text; we don't interpret it.
 *   - "They violated the cooling-off period" — cooling-off analysis requires
 *     statutory interpretation we refuse to do automatically. We surface
 *     the disclosed facts and let a human lawyer decide.
 */

import type { LdaClient } from "../core/lda-client.ts";
import {
  searchLobbyists,
  listFilingsForLobbyist,
  filingHumanUrl,
  filingSpend,
  type Filing,
  type LobbyistSearchResult,
} from "../core/lda-endpoints.ts";
import type { DbClient } from "../db/engine.ts";
import { upsertFilingsBatch, upsertEntity, upsertEntityAlias, entityKey } from "../db/repos.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";
import { fmtUsd } from "../core/types.ts";

export const SKILL_NAME = "revolving-door";
export const SCHEMA_VERSION = 1;

export interface RevolvingDoorInput {
  /** Free-text lobbyist name (e.g. "Smith, John"). One of this or lobbyist_id required. */
  person?: string;
  lobbyist_id?: number;
  year_start: number;
  year_end: number;
}

export interface RevolvingDoorData {
  person: {
    lobbyist_id: number;
    display: string;
    candidate_count: number;
  };
  window: TimeWindow;
  totals: {
    filings_touched: number;
    unique_clients: number;
    unique_registrants: number;
    unique_covered_positions: number;
    new_registration_flags: number;
  };
  covered_positions: Array<{
    position: string;
    filings: number;
    first_seen_year: number;
    last_seen_year: number;
    exemplar_filing_uuid: string;
    exemplar_filing_url: string;
  }>;
  clients_lobbied: Array<{
    client_id: number;
    client_name: string;
    filings: number;
    first_year: number;
    last_year: number;
    total_spend: number;
  }>;
  registrants: Array<{
    registrant_id: number;
    registrant_name: string;
    filings: number;
    first_year: number;
    last_year: number;
  }>;
  issue_codes: Array<{ code: string; display: string; filings: number }>;
  timeline: Array<{
    year: number;
    quarter: number | null;
    filing_uuid: string;
    filing_url: string;
    client: string;
    registrant: string;
    covered_position: string | null;
  }>;
}

// ---------------------------------------------------------------------------

export async function runRevolvingDoor(
  lda: LdaClient,
  db: DbClient,
  input: RevolvingDoorInput,
): Promise<Brief<RevolvingDoorData>> {
  // 1. Resolve lobbyist
  let lobbyist_id = input.lobbyist_id;
  let display: string;
  let candidate_count = 1;

  if (lobbyist_id === undefined) {
    if (!input.person) throw new Error("revolving-door requires `person` or `lobbyist_id`.");
    const hits = await searchLobbyists(lda, input.person);
    if (hits.length === 0) {
      throw new Error(`revolving-door: no LDA lobbyist matched "${input.person}".`);
    }
    candidate_count = hits.length;
    // Best match: exact (lastname, firstname) match first.
    const needle = input.person.toLowerCase();
    const best = pickBestLobbyist(hits, needle);
    lobbyist_id = best.id;
    display = lobbyistDisplay(best);
  } else {
    display = `lobbyist #${lobbyist_id}`;
  }

  // 2. Fetch filings this lobbyist appears on
  const filings = await listFilingsForLobbyist(lda, {
    lobbyistId: lobbyist_id,
    yearStart: input.year_start,
    yearEnd: input.year_end,
  });
  await upsertFilingsBatch(db, filings);

  // Persist the lobbyist as an entity + alias
  await upsertEntity(db, {
    kind: "lobbyist",
    id: String(lobbyist_id),
    display,
    external_id: String(lobbyist_id),
  });
  await upsertEntityAlias(db, {
    entity_id: entityKey("lobbyist", String(lobbyist_id)),
    raw: display,
    source: "lda",
  });
  if (input.person && input.person !== display) {
    await upsertEntityAlias(db, {
      entity_id: entityKey("lobbyist", String(lobbyist_id)),
      raw: input.person,
      source: "user",
    });
  }

  // 3. Aggregate
  const data = aggregate(filings, lobbyist_id, display, candidate_count, {
    year_start: input.year_start,
    year_end: input.year_end,
  });

  // 4. Citations + markdown
  const citations = buildCitations(data);
  const markdown = renderMarkdown(data);

  const entity: EntityId = {
    kind: "lobbyist",
    id: String(lobbyist_id),
    display,
  };

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    entity,
    window: { year_start: input.year_start, year_end: input.year_end },
    generated_at: new Date().toISOString(),
    data,
    citations,
    markdown,
  };
}

// ---------------------------------------------------------------------------

function lobbyistDisplay(l: LobbyistSearchResult): string {
  return [l.first_name, l.last_name, l.suffix].filter(Boolean).join(" ").trim() || `lobbyist #${l.id}`;
}

function pickBestLobbyist(hits: LobbyistSearchResult[], needle: string): LobbyistSearchResult {
  const needle_lower = needle.toLowerCase();
  const exact = hits.find((h) => {
    const full = lobbyistDisplay(h).toLowerCase();
    const rev = `${(h.last_name ?? "").toLowerCase()}, ${(h.first_name ?? "").toLowerCase()}`.trim();
    return full === needle_lower || rev === needle_lower;
  });
  if (exact) return exact;
  return hits[0]!;
}

function aggregate(
  filings: Filing[],
  lobbyist_id: number,
  display: string,
  candidate_count: number,
  window: { year_start: number; year_end: number },
): RevolvingDoorData {
  const covered_positions = new Map<
    string,
    { filings: number; first_year: number; last_year: number; exemplar: Filing }
  >();
  const clients = new Map<number, { name: string; filings: number; first_year: number; last_year: number; total_spend: number }>();
  const registrants = new Map<number, { name: string; filings: number; first_year: number; last_year: number }>();
  const issue_codes = new Map<string, { display: string; filings: number }>();
  const timeline: RevolvingDoorData["timeline"] = [];

  let filings_touched = 0;
  let new_registration_flags = 0;

  for (const f of filings) {
    filings_touched += 1;

    const spend = filingSpend(f) ?? 0;
    const cEntry = clients.get(f.client.id) ?? {
      name: f.client.name,
      filings: 0,
      first_year: f.filing_year,
      last_year: f.filing_year,
      total_spend: 0,
    };
    cEntry.filings += 1;
    cEntry.total_spend += spend;
    cEntry.first_year = Math.min(cEntry.first_year, f.filing_year);
    cEntry.last_year = Math.max(cEntry.last_year, f.filing_year);
    clients.set(f.client.id, cEntry);

    const rEntry = registrants.get(f.registrant.id) ?? {
      name: f.registrant.name,
      filings: 0,
      first_year: f.filing_year,
      last_year: f.filing_year,
    };
    rEntry.filings += 1;
    rEntry.first_year = Math.min(rEntry.first_year, f.filing_year);
    rEntry.last_year = Math.max(rEntry.last_year, f.filing_year);
    registrants.set(f.registrant.id, rEntry);

    // Find this lobbyist's covered_position in each activity.
    let positionOnThisFiling: string | null = null;
    for (const act of f.lobbying_activities ?? []) {
      if (act.general_issue_code) {
        const icode = act.general_issue_code;
        const i = issue_codes.get(icode) ?? {
          display: act.general_issue_code_display ?? icode,
          filings: 0,
        };
        i.filings += 1;
        issue_codes.set(icode, i);
      }
      for (const la of act.lobbyists ?? []) {
        if (la.lobbyist.id !== lobbyist_id) continue;
        if (la.new) new_registration_flags += 1;
        const pos = la.covered_position?.trim();
        if (pos) {
          positionOnThisFiling = pos;
          const existing = covered_positions.get(pos);
          if (!existing) {
            covered_positions.set(pos, {
              filings: 1,
              first_year: f.filing_year,
              last_year: f.filing_year,
              exemplar: f,
            });
          } else {
            existing.filings += 1;
            existing.first_year = Math.min(existing.first_year, f.filing_year);
            existing.last_year = Math.max(existing.last_year, f.filing_year);
          }
        }
      }
    }

    timeline.push({
      year: f.filing_year,
      quarter: null, // derive below
      filing_uuid: f.filing_uuid,
      filing_url: filingHumanUrl(f),
      client: f.client.name,
      registrant: f.registrant.name,
      covered_position: positionOnThisFiling,
    });
  }

  // Decode quarter from filing_period on the timeline
  const qmap: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 };
  for (let i = 0; i < timeline.length; i++) {
    const f = filings[i]!;
    const p = (f.filing_period || "").split("_")[0]?.toLowerCase() ?? "";
    const q = qmap[p];
    if (q !== undefined) timeline[i]!.quarter = q;
  }

  timeline.sort((a, b) => a.year - b.year || (a.quarter ?? 0) - (b.quarter ?? 0));

  return {
    person: {
      lobbyist_id,
      display,
      candidate_count,
    },
    window: { year_start: window.year_start, year_end: window.year_end },
    totals: {
      filings_touched,
      unique_clients: clients.size,
      unique_registrants: registrants.size,
      unique_covered_positions: covered_positions.size,
      new_registration_flags,
    },
    covered_positions: [...covered_positions.entries()]
      .sort((a, b) => b[1].filings - a[1].filings)
      .map(([position, v]) => ({
        position,
        filings: v.filings,
        first_seen_year: v.first_year,
        last_seen_year: v.last_year,
        exemplar_filing_uuid: v.exemplar.filing_uuid,
        exemplar_filing_url: filingHumanUrl(v.exemplar),
      })),
    clients_lobbied: [...clients.entries()]
      .sort((a, b) => b[1].total_spend - a[1].total_spend || b[1].filings - a[1].filings)
      .slice(0, 25)
      .map(([cid, v]) => ({
        client_id: cid,
        client_name: v.name,
        filings: v.filings,
        first_year: v.first_year,
        last_year: v.last_year,
        total_spend: v.total_spend,
      })),
    registrants: [...registrants.entries()]
      .sort((a, b) => b[1].filings - a[1].filings)
      .slice(0, 15)
      .map(([rid, v]) => ({
        registrant_id: rid,
        registrant_name: v.name,
        filings: v.filings,
        first_year: v.first_year,
        last_year: v.last_year,
      })),
    issue_codes: [...issue_codes.entries()]
      .sort((a, b) => b[1].filings - a[1].filings)
      .slice(0, 15)
      .map(([code, v]) => ({ code, display: v.display, filings: v.filings })),
    timeline,
  };
}

function buildCitations(data: RevolvingDoorData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();
  for (const p of data.covered_positions) {
    cites.push({
      key: `cov_${citeKey(p.position)}`,
      description: `Covered position disclosure: ${p.position}`,
      source: "lda",
      url: p.exemplar_filing_url,
      source_id: p.exemplar_filing_uuid,
      quote: p.position,
      fetched_at,
    });
  }
  return cites;
}

function citeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
}

function renderMarkdown(data: RevolvingDoorData): string {
  const lines: string[] = [];
  lines.push(`## ${data.person.display} — Revolving-Door Profile`);
  lines.push("");
  if (data.totals.filings_touched === 0) {
    lines.push(`No LDA filings list ${data.person.display} as a lobbyist in ${data.window.year_start}–${data.window.year_end}.`);
    return lines.join("\n");
  }

  lines.push(
    `Appeared on **${data.totals.filings_touched}** filings across **${data.totals.unique_clients}** clients and **${data.totals.unique_registrants}** firms between ${data.window.year_start} and ${data.window.year_end}.`,
  );
  if (data.person.candidate_count > 1) {
    lines.push(
      `> Note: ${data.person.candidate_count} LDA lobbyist records matched this name. This report covers the highest-confidence match. If this isn't the right person, re-run with --lobbyist-id=<id>.`,
    );
  }

  if (data.covered_positions.length > 0) {
    lines.push("");
    lines.push("### Covered positions disclosed (the revolving door)");
    lines.push("");
    for (const p of data.covered_positions) {
      const range =
        p.first_seen_year === p.last_seen_year
          ? `${p.first_seen_year}`
          : `${p.first_seen_year}–${p.last_seen_year}`;
      lines.push(
        `- **${p.position}** — disclosed on ${p.filings} ${plural("filing", p.filings)}, ${range}. [cov_${citeKey(p.position)}]`,
      );
    }
    lines.push("");
    lines.push(
      "> Covered positions are what the lobbyist themselves disclosed on the filing. We do not interpret cooling-off compliance; that's a legal question for a human lawyer.",
    );
  }

  if (data.registrants.length > 0) {
    lines.push("");
    lines.push("### Employing firms (registrants)");
    lines.push("");
    for (const r of data.registrants.slice(0, 10)) {
      const range =
        r.first_year === r.last_year ? `${r.first_year}` : `${r.first_year}–${r.last_year}`;
      lines.push(`- **${r.registrant_name}** (${r.filings} ${plural("filing", r.filings)}, ${range}).`);
    }
  }

  if (data.clients_lobbied.length > 0) {
    lines.push("");
    lines.push("### Top clients lobbied for");
    lines.push("");
    lines.push("| Client | Filings | Years | Reported spend |");
    lines.push("| ------ | ------- | ----- | -------------- |");
    for (const c of data.clients_lobbied.slice(0, 15)) {
      const range =
        c.first_year === c.last_year ? `${c.first_year}` : `${c.first_year}–${c.last_year}`;
      lines.push(`| ${c.client_name} | ${c.filings} | ${range} | ${fmtUsd(c.total_spend)} |`);
    }
  }

  if (data.issue_codes.length > 0) {
    lines.push("");
    lines.push("### Issue areas worked on");
    lines.push("");
    for (const i of data.issue_codes.slice(0, 10)) {
      lines.push(`- **${i.code}** — ${i.display} (${i.filings} ${plural("filing", i.filings)}).`);
    }
  }

  lines.push("");
  lines.push(
    "> What was disclosed — not whether cooling-off rules were followed. Every claim cites an LDA filing.",
  );
  return lines.join("\n");
}

function plural(w: string, n: number): string {
  return n === 1 ? w : `${w}s`;
}
