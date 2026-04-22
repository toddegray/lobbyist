/**
 * filing-diff — compare two quarterly filings (or two year windows) for the
 * same client.
 *
 * Given a client + a "from" window + a "to" window, surfaces:
 *   - Issue codes added / dropped
 *   - Lobbyists added / dropped
 *   - Registrants added / dropped
 *   - Spend delta (absolute + percentage)
 *   - Government entities added / dropped
 *
 * Typical uses:
 *   - "What changed for Amazon between Q3 and Q4 2024?"
 *   - "How is Pfizer's lobbying different in 2024 vs 2020?"
 *
 * All diffs come from filings we've already mirrored locally, plus a fresh
 * fetch to catch anything new. Pure data — no LLM rewriting.
 */

import type { LdaClient } from "../core/lda-client.ts";
import {
  listFilingsForClient,
  filingSpend,
  filingQuarter,
  filingHumanUrl,
  type Filing,
} from "../core/lda-endpoints.ts";
import { resolveClient } from "../core/resolve.ts";
import type { DbClient } from "../db/engine.ts";
import { upsertFilingsBatch } from "../db/repos.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";
import { fmtPct, fmtUsd } from "../core/types.ts";

export const SKILL_NAME = "filing-diff";
export const SCHEMA_VERSION = 1;

export interface FilingDiffInput {
  client?: string;
  client_id?: number;
  from_window: TimeWindow;
  to_window: TimeWindow;
}

export interface FilingDiffData {
  client: { client_id: number; name: string };
  from_window: TimeWindow;
  to_window: TimeWindow;
  from_totals: DiffBucket;
  to_totals: DiffBucket;
  deltas: {
    spend_delta: number;
    spend_delta_pct: number | null;
    filings_delta: number;
    lobbyists_added: Array<{ lobbyist_id: number; name: string; first_seen_in: string; exemplar_filing_uuid: string; exemplar_filing_url: string }>;
    lobbyists_dropped: Array<{ lobbyist_id: number; name: string }>;
    issues_added: Array<{ code: string; display: string }>;
    issues_dropped: Array<{ code: string; display: string }>;
    registrants_added: Array<{ registrant_id: number; name: string }>;
    registrants_dropped: Array<{ registrant_id: number; name: string }>;
    govt_entities_added: string[];
    govt_entities_dropped: string[];
  };
}

interface DiffBucket {
  filings: number;
  spend: number;
  lobbyists: Array<{ lobbyist_id: number; name: string }>;
  issues: Array<{ code: string; display: string }>;
  registrants: Array<{ registrant_id: number; name: string }>;
  govt_entities: string[];
}

// ---------------------------------------------------------------------------

export async function runFilingDiff(
  lda: LdaClient,
  db: DbClient,
  input: FilingDiffInput,
): Promise<Brief<FilingDiffData>> {
  // Resolve client
  let client_id = input.client_id;
  let client_name: string;
  if (client_id === undefined) {
    if (!input.client) throw new Error("filing-diff requires `client` or `client_id`.");
    const res = await resolveClient(db, lda, input.client);
    if (!res) throw new Error(`filing-diff: no LDA client matched "${input.client}".`);
    client_id = res.client_id;
    client_name = res.name;
  } else {
    client_name = `client #${client_id}`;
  }

  // Fetch the superset year range so both windows are covered
  const supersetStart = Math.min(input.from_window.year_start, input.to_window.year_start);
  const supersetEnd = Math.max(input.from_window.year_end, input.to_window.year_end);
  const filings = await listFilingsForClient(lda, {
    clientId: client_id,
    yearStart: supersetStart,
    yearEnd: supersetEnd,
  });
  await upsertFilingsBatch(db, filings);
  if (filings[0]) client_name = filings[0].client.name;

  const fromFilings = filings.filter((f) => inWindow(f, input.from_window));
  const toFilings = filings.filter((f) => inWindow(f, input.to_window));

  const from_totals = bucketize(fromFilings);
  const to_totals = bucketize(toFilings);

  const deltas = computeDeltas(from_totals, to_totals, toFilings);

  const data: FilingDiffData = {
    client: { client_id, name: client_name },
    from_window: input.from_window,
    to_window: input.to_window,
    from_totals,
    to_totals,
    deltas,
  };

  const citations = buildCitations(filings, data);
  const entity: EntityId = { kind: "client", id: String(client_id), display: client_name };
  const markdown = renderMarkdown(data);

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    entity,
    window: {
      year_start: supersetStart,
      year_end: supersetEnd,
    },
    generated_at: new Date().toISOString(),
    data,
    citations,
    markdown,
  };
}

// ---------------------------------------------------------------------------

function inWindow(f: Filing, w: TimeWindow): boolean {
  if (f.filing_year < w.year_start || f.filing_year > w.year_end) return false;
  if (w.quarter === undefined) return true;
  return filingQuarter(f) === w.quarter;
}

function bucketize(filings: Filing[]): DiffBucket {
  const lobbyists = new Map<number, string>();
  const issues = new Map<string, string>();
  const registrants = new Map<number, string>();
  const govt = new Set<string>();
  let spend = 0;
  for (const f of filings) {
    spend += filingSpend(f) ?? 0;
    registrants.set(f.registrant.id, f.registrant.name);
    for (const a of f.lobbying_activities ?? []) {
      if (a.general_issue_code) {
        issues.set(a.general_issue_code, a.general_issue_code_display ?? a.general_issue_code);
      }
      for (const la of a.lobbyists ?? []) {
        const name = [la.lobbyist.first_name, la.lobbyist.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || `lobbyist #${la.lobbyist.id}`;
        lobbyists.set(la.lobbyist.id, name);
      }
      for (const ge of a.government_entities ?? []) govt.add(ge.name);
    }
  }
  return {
    filings: filings.length,
    spend,
    lobbyists: [...lobbyists.entries()].map(([lid, name]) => ({ lobbyist_id: lid, name })),
    issues: [...issues.entries()].map(([code, display]) => ({ code, display })),
    registrants: [...registrants.entries()].map(([rid, name]) => ({ registrant_id: rid, name })),
    govt_entities: [...govt].sort(),
  };
}

function computeDeltas(
  from: DiffBucket,
  to: DiffBucket,
  toFilings: Filing[],
): FilingDiffData["deltas"] {
  const fromLIds = new Set(from.lobbyists.map((l) => l.lobbyist_id));
  const toLIds = new Set(to.lobbyists.map((l) => l.lobbyist_id));
  const fromICodes = new Set(from.issues.map((i) => i.code));
  const toICodes = new Set(to.issues.map((i) => i.code));
  const fromRIds = new Set(from.registrants.map((r) => r.registrant_id));
  const toRIds = new Set(to.registrants.map((r) => r.registrant_id));
  const fromGovt = new Set(from.govt_entities);
  const toGovt = new Set(to.govt_entities);

  // For lobbyists_added, find the first filing in `to` where they appear.
  const lobbyistExemplar = new Map<number, Filing>();
  for (const f of toFilings) {
    for (const a of f.lobbying_activities ?? []) {
      for (const la of a.lobbyists ?? []) {
        if (!lobbyistExemplar.has(la.lobbyist.id)) {
          lobbyistExemplar.set(la.lobbyist.id, f);
        }
      }
    }
  }

  const lobbyists_added = to.lobbyists
    .filter((l) => !fromLIds.has(l.lobbyist_id))
    .map((l) => {
      const ex = lobbyistExemplar.get(l.lobbyist_id);
      return {
        lobbyist_id: l.lobbyist_id,
        name: l.name,
        first_seen_in: ex ? `${ex.filing_year}-${filingQuarter(ex) ?? "?"}` : "?",
        exemplar_filing_uuid: ex?.filing_uuid ?? "",
        exemplar_filing_url: ex ? filingHumanUrl(ex) : "",
      };
    });

  const lobbyists_dropped = from.lobbyists
    .filter((l) => !toLIds.has(l.lobbyist_id))
    .map((l) => ({ lobbyist_id: l.lobbyist_id, name: l.name }));

  const issues_added = to.issues.filter((i) => !fromICodes.has(i.code));
  const issues_dropped = from.issues.filter((i) => !toICodes.has(i.code));
  const registrants_added = to.registrants
    .filter((r) => !fromRIds.has(r.registrant_id))
    .map((r) => ({ registrant_id: r.registrant_id, name: r.name }));
  const registrants_dropped = from.registrants
    .filter((r) => !toRIds.has(r.registrant_id))
    .map((r) => ({ registrant_id: r.registrant_id, name: r.name }));
  const govt_entities_added = [...toGovt].filter((g) => !fromGovt.has(g)).sort();
  const govt_entities_dropped = [...fromGovt].filter((g) => !toGovt.has(g)).sort();

  const spend_delta = to.spend - from.spend;
  const spend_delta_pct = from.spend > 0 ? spend_delta / from.spend : null;
  const filings_delta = to.filings - from.filings;

  return {
    spend_delta,
    spend_delta_pct,
    filings_delta,
    lobbyists_added,
    lobbyists_dropped,
    issues_added,
    issues_dropped,
    registrants_added,
    registrants_dropped,
    govt_entities_added,
    govt_entities_dropped,
  };
}

function buildCitations(filings: Filing[], data: FilingDiffData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();
  for (const l of data.deltas.lobbyists_added) {
    if (!l.exemplar_filing_url) continue;
    cites.push({
      key: `new_lobbyist_${l.lobbyist_id}`,
      description: `${l.name} first appears in ${l.first_seen_in}`,
      source: "lda",
      url: l.exemplar_filing_url,
      source_id: l.exemplar_filing_uuid,
      fetched_at,
    });
  }
  return cites;
}

function renderMarkdown(data: FilingDiffData): string {
  const lines: string[] = [];
  lines.push(`## ${data.client.name} — Filing Diff`);
  lines.push("");
  lines.push(
    `Comparing **${windowLabel(data.from_window)}** → **${windowLabel(data.to_window)}**.`,
  );
  lines.push("");
  lines.push(
    `- Filings: ${data.from_totals.filings} → ${data.to_totals.filings} (Δ ${signed(data.deltas.filings_delta)})`,
  );
  lines.push(
    `- Spend: ${fmtUsd(data.from_totals.spend)} → ${fmtUsd(data.to_totals.spend)} (Δ ${signed(data.deltas.spend_delta)}${data.deltas.spend_delta_pct !== null ? `, ${signedPct(data.deltas.spend_delta_pct)}` : ""})`,
  );

  if (data.deltas.lobbyists_added.length > 0) {
    lines.push("");
    lines.push("### New lobbyists");
    lines.push("");
    for (const l of data.deltas.lobbyists_added) {
      lines.push(`- ${l.name} (first seen ${l.first_seen_in}) [new_lobbyist_${l.lobbyist_id}]`);
    }
  }
  if (data.deltas.lobbyists_dropped.length > 0) {
    lines.push("");
    lines.push("### Lobbyists no longer listed");
    lines.push("");
    for (const l of data.deltas.lobbyists_dropped) {
      lines.push(`- ${l.name}`);
    }
  }
  if (data.deltas.issues_added.length > 0) {
    lines.push("");
    lines.push("### Issues added");
    lines.push("");
    for (const i of data.deltas.issues_added) {
      lines.push(`- **${i.code}** — ${i.display}`);
    }
  }
  if (data.deltas.issues_dropped.length > 0) {
    lines.push("");
    lines.push("### Issues dropped");
    lines.push("");
    for (const i of data.deltas.issues_dropped) {
      lines.push(`- **${i.code}** — ${i.display}`);
    }
  }
  if (data.deltas.registrants_added.length > 0) {
    lines.push("");
    lines.push("### New firms hired");
    lines.push("");
    for (const r of data.deltas.registrants_added) {
      lines.push(`- ${r.name}`);
    }
  }
  if (data.deltas.registrants_dropped.length > 0) {
    lines.push("");
    lines.push("### Firms no longer retained");
    lines.push("");
    for (const r of data.deltas.registrants_dropped) {
      lines.push(`- ${r.name}`);
    }
  }
  if (data.deltas.govt_entities_added.length > 0) {
    lines.push("");
    lines.push("### New government entities contacted");
    lines.push("");
    for (const g of data.deltas.govt_entities_added) {
      lines.push(`- ${g}`);
    }
  }
  lines.push("");
  lines.push(
    "> Diff computed over filings as of fetch time. LDA filings are frequently amended; re-run for the latest.",
  );
  return lines.join("\n");
}

function windowLabel(w: TimeWindow): string {
  const base =
    w.year_start === w.year_end ? `${w.year_start}` : `${w.year_start}–${w.year_end}`;
  return w.quarter ? `${base} Q${w.quarter}` : base;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
function signedPct(ratio: number): string {
  const p = fmtPct(Math.abs(ratio));
  return ratio >= 0 ? `+${p}` : `-${p}`;
}
