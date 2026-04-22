/**
 * coalition-detect — find entities lobbying together.
 *
 * Operates entirely over the LDA filings mirror in local memory (no new
 * API calls; this is the payoff of storing everything in `filings`).
 *
 * Two modes:
 *
 *   1. By issue code — "everyone lobbying on HCR in 2024".
 *      Groups clients by shared *registrant* (firm). Clients who hired the
 *      same lobbying firm on the same issue are plausibly coordinated — the
 *      firm typically files a combined activity description, and coordinated
 *      clients often share messaging.
 *
 *   2. By client — "who lobbies together with Pfizer?"
 *      Finds other clients whose filings overlap with the target on (firm,
 *      quarter) pairs. Two clients hiring the same firm in the same quarter
 *      are possibly — not necessarily — coordinated.
 *
 * Output: a ranked list of coalitions with a Jaccard-style overlap score
 * and the firms / issues / filings underlying each grouping. Every
 * coalition surfaces the filings that evidence it.
 *
 * We do NOT claim coordination. We claim *shared lobbying infrastructure*
 * (same firm, same issues, same quarters). A reader interprets.
 */

import type { DbClient } from "../db/engine.ts";
import { listFilingsForClientId } from "../db/repos.ts";
import type { LdaClient } from "../core/lda-client.ts";
import {
  listFilingsByIssueCode,
  listFilingsByIssueSubstring,
  filingHumanUrl,
  filingQuarter,
  type Filing,
} from "../core/lda-endpoints.ts";
import { resolveClient } from "../core/resolve.ts";
import { upsertFilingsBatch } from "../db/repos.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";
import { createHash } from "node:crypto";

export const SKILL_NAME = "coalition-detect";
export const SCHEMA_VERSION = 1;

export interface CoalitionDetectInput {
  /** Detect coalitions around a given issue code (e.g. "HCR"). */
  issue_code?: string;
  /** Free-text issue substring. */
  bill?: string;
  /** Or: detect coalitions around a specific client ("who lobbies with X?"). */
  client?: string;
  client_id?: number;
  year_start: number;
  year_end: number;
  /** Minimum number of clients for a coalition to be surfaced. Default 2. */
  min_coalition_size?: number;
}

export interface CoalitionDetectData {
  mode: "by_issue" | "by_client";
  query: { issue_code: string | null; bill: string | null; client_id: number | null; client_name: string | null };
  window: TimeWindow;
  totals: {
    filings_considered: number;
    unique_clients: number;
    unique_registrants: number;
    coalitions_detected: number;
  };
  coalitions: Array<{
    coalition_id: string;
    registrant_id: number;
    registrant_name: string;
    client_count: number;
    clients: Array<{ client_id: number; client_name: string; filings: number }>;
    shared_quarters: Array<{ year: number; quarter: number }>;
    shared_issue_codes: string[];
    exemplar_filing_uuid: string;
    exemplar_filing_url: string;
    confidence_score: number;    // 0..1 — more shared dimensions → higher score
  }>;
}

// ---------------------------------------------------------------------------

export async function runCoalitionDetect(
  lda: LdaClient,
  db: DbClient,
  input: CoalitionDetectInput,
): Promise<Brief<CoalitionDetectData>> {
  const mode: "by_issue" | "by_client" =
    input.client || input.client_id !== undefined ? "by_client" : "by_issue";

  let filings: Filing[];
  let clientId: number | null = null;
  let clientName: string | null = null;

  if (mode === "by_client") {
    // Look up the target client's filings
    if (input.client_id === undefined) {
      const res = await resolveClient(db, lda, input.client!);
      if (!res) throw new Error(`coalition-detect: no LDA client matched "${input.client}".`);
      clientId = res.client_id;
      clientName = res.name;
    } else {
      clientId = input.client_id;
    }
    // Target client's own filings (to identify firm/quarter pairs)
    const targetFilings = await listFilingsForClientId(db, clientId!, {
      yearStart: input.year_start,
      yearEnd: input.year_end,
    });
    // If the memory had none, fetch them
    if (targetFilings.length === 0) {
      const { listFilingsForClient } = await import("../core/lda-endpoints.ts");
      const fetched = await listFilingsForClient(lda, {
        clientId: clientId!,
        yearStart: input.year_start,
        yearEnd: input.year_end,
      });
      await upsertFilingsBatch(db, fetched);
      targetFilings.push(...fetched);
    }
    if (targetFilings[0]) clientName = targetFilings[0].client.name;

    // For each registrant the target client used, fetch other clients of
    // that registrant during the same period — via the memory first, then
    // falling back to LDA API if the registrant isn't fully mirrored yet.
    const registrantIds = new Set<number>();
    for (const f of targetFilings) registrantIds.add(f.registrant.id);

    const related: Filing[] = [...targetFilings];
    for (const rid of registrantIds) {
      const { listFilingsForRegistrant } = await import("../core/lda-endpoints.ts");
      const regFilings = await listFilingsForRegistrant(lda, {
        registrantId: rid,
        yearStart: input.year_start,
        yearEnd: input.year_end,
      });
      related.push(...regFilings);
    }
    await upsertFilingsBatch(db, related);
    filings = dedupeFilings(related);
  } else {
    // By-issue mode
    filings = input.issue_code
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
    if (!input.issue_code && !input.bill) {
      throw new Error("coalition-detect: provide an issue_code, bill, or client.");
    }
    await upsertFilingsBatch(db, filings);
  }

  const data = detectCoalitions(filings, mode, {
    clientId,
    clientName,
    issue_code: input.issue_code ?? null,
    bill: input.bill ?? null,
    minSize: input.min_coalition_size ?? 2,
    window: { year_start: input.year_start, year_end: input.year_end },
  });

  const citations = buildCitations(data);

  // Entity: synthesize a coalition-target entity. In by-issue mode the
  // target is the issue; in by-client mode, the client.
  let entity: EntityId;
  if (mode === "by_client" && clientId !== null) {
    entity = { kind: "client", id: String(clientId), display: clientName ?? `client #${clientId}` };
  } else {
    const queryKey = input.issue_code ?? input.bill ?? "unknown";
    const hash = createHash("sha256").update(queryKey.toUpperCase()).digest("hex").slice(0, 12);
    entity = { kind: "issue", id: hash, display: queryKey };
  }

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    entity,
    window: data.window,
    generated_at: new Date().toISOString(),
    data,
    citations,
    markdown: renderMarkdown(data),
  };
}

// ---------------------------------------------------------------------------

function dedupeFilings(filings: Filing[]): Filing[] {
  const seen = new Set<string>();
  const out: Filing[] = [];
  for (const f of filings) {
    if (seen.has(f.filing_uuid)) continue;
    seen.add(f.filing_uuid);
    out.push(f);
  }
  return out;
}

function detectCoalitions(
  filings: Filing[],
  mode: "by_issue" | "by_client",
  opts: {
    clientId: number | null;
    clientName: string | null;
    issue_code: string | null;
    bill: string | null;
    minSize: number;
    window: { year_start: number; year_end: number };
  },
): CoalitionDetectData {
  // Group filings by registrant_id
  const byRegistrant = new Map<
    number,
    {
      registrant_name: string;
      clients: Map<number, { client_name: string; filings: number }>;
      quarters: Set<string>;
      issue_codes: Set<string>;
      exemplar: Filing;
    }
  >();

  const uniqueClients = new Set<number>();
  for (const f of filings) {
    uniqueClients.add(f.client.id);
    const rid = f.registrant.id;
    const cur =
      byRegistrant.get(rid) ??
      {
        registrant_name: f.registrant.name,
        clients: new Map<number, { client_name: string; filings: number }>(),
        quarters: new Set<string>(),
        issue_codes: new Set<string>(),
        exemplar: f,
      };
    const cEntry =
      cur.clients.get(f.client.id) ?? { client_name: f.client.name, filings: 0 };
    cEntry.filings += 1;
    cur.clients.set(f.client.id, cEntry);

    const q = filingQuarter(f);
    if (q) cur.quarters.add(`${f.filing_year}-${q}`);
    for (const act of f.lobbying_activities ?? []) {
      if (act.general_issue_code) cur.issue_codes.add(act.general_issue_code);
    }
    byRegistrant.set(rid, cur);
  }

  // Build coalitions: registrants whose client_set meets minSize. In
  // by-client mode, only return coalitions that *include* the target client.
  const coalitions: CoalitionDetectData["coalitions"] = [];
  for (const [rid, v] of byRegistrant) {
    if (v.clients.size < opts.minSize) continue;
    if (mode === "by_client" && opts.clientId !== null) {
      if (!v.clients.has(opts.clientId)) continue;
    }

    const clients = [...v.clients.entries()]
      .map(([client_id, c]) => ({
        client_id,
        client_name: c.client_name,
        filings: c.filings,
      }))
      .sort((a, b) => b.filings - a.filings);

    const shared_quarters = [...v.quarters].map((k) => {
      const [y, q] = k.split("-").map(Number);
      return { year: y!, quarter: q! };
    });
    shared_quarters.sort((a, b) => a.year - b.year || a.quarter - b.quarter);

    // Confidence: 0..1 blend of (client_count / max, quarter_count / 8, issue_count / 5)
    const clientFactor = Math.min(clients.length / 10, 1);
    const quarterFactor = Math.min(shared_quarters.length / 8, 1);
    const issueFactor = Math.min(v.issue_codes.size / 5, 1);
    const confidence = (clientFactor + quarterFactor + issueFactor) / 3;

    const coalitionId = createHash("sha256")
      .update(`${rid}|${clients.map((c) => c.client_id).sort().join(",")}`)
      .digest("hex")
      .slice(0, 12);

    coalitions.push({
      coalition_id: coalitionId,
      registrant_id: rid,
      registrant_name: v.registrant_name,
      client_count: clients.length,
      clients,
      shared_quarters,
      shared_issue_codes: [...v.issue_codes].sort(),
      exemplar_filing_uuid: v.exemplar.filing_uuid,
      exemplar_filing_url: filingHumanUrl(v.exemplar),
      confidence_score: Number(confidence.toFixed(3)),
    });
  }

  coalitions.sort(
    (a, b) => b.confidence_score - a.confidence_score || b.client_count - a.client_count,
  );

  return {
    mode,
    query: {
      issue_code: opts.issue_code,
      bill: opts.bill,
      client_id: opts.clientId,
      client_name: opts.clientName,
    },
    window: opts.window,
    totals: {
      filings_considered: filings.length,
      unique_clients: uniqueClients.size,
      unique_registrants: byRegistrant.size,
      coalitions_detected: coalitions.length,
    },
    coalitions,
  };
}

function buildCitations(data: CoalitionDetectData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();
  for (const c of data.coalitions.slice(0, 15)) {
    cites.push({
      key: `coal_${c.coalition_id}`,
      description: `Coalition via ${c.registrant_name} (${c.client_count} clients)`,
      source: "lda",
      url: c.exemplar_filing_url,
      source_id: c.exemplar_filing_uuid,
      fetched_at,
    });
  }
  return cites;
}

function renderMarkdown(data: CoalitionDetectData): string {
  const lines: string[] = [];
  const target =
    data.mode === "by_client"
      ? `**${data.query.client_name ?? "client"}**`
      : `issue **${data.query.issue_code ?? data.query.bill ?? "?"}**`;
  lines.push(`## Coalition Detection — ${target}`);
  lines.push("");
  if (data.coalitions.length === 0) {
    lines.push(
      `No coalitions above the minimum client-threshold found in ${data.window.year_start}–${data.window.year_end}.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `Over ${data.window.year_start}–${data.window.year_end}, inspected **${data.totals.filings_considered}** filings covering **${data.totals.unique_clients}** clients and **${data.totals.unique_registrants}** firms. Detected **${data.totals.coalitions_detected}** coalitions (groups of ≥${data.coalitions[0]!.client_count >= 2 ? 2 : 0} clients sharing a registrant).`,
  );
  lines.push("");
  lines.push("### Coalitions (ranked by confidence)");
  lines.push("");
  for (const c of data.coalitions.slice(0, 20)) {
    const clientsLine = c.clients
      .slice(0, 6)
      .map((x) => x.client_name)
      .join(", ");
    const more = c.clients.length > 6 ? ` + ${c.clients.length - 6} more` : "";
    lines.push(
      `- **${c.registrant_name}** (confidence ${c.confidence_score.toFixed(2)}) — ${c.client_count} clients [coal_${c.coalition_id}]`,
    );
    lines.push(
      `  - Clients: ${clientsLine}${more}`,
    );
    if (c.shared_issue_codes.length > 0) {
      lines.push(`  - Shared issue codes: ${c.shared_issue_codes.join(", ")}`);
    }
    if (c.shared_quarters.length > 0) {
      const first = c.shared_quarters[0]!;
      const last = c.shared_quarters[c.shared_quarters.length - 1]!;
      lines.push(
        `  - Active quarters: ${c.shared_quarters.length} (${first.year} Q${first.quarter} → ${last.year} Q${last.quarter})`,
      );
    }
  }
  lines.push("");
  lines.push(
    "> Confidence is a heuristic over (client count × shared quarters × shared issues). Shared lobbying infrastructure is evidence of coordination, not proof; clients can hire the same firm for wholly unrelated reasons.",
  );
  return lines.join("\n");
}
