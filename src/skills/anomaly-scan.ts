/**
 * anomaly-scan — broader pattern scan on a client's filings.
 *
 * Distinct from `spend-analysis` (which looks at money only). `anomaly-scan`
 * looks at everything else:
 *
 *   - **Late filings** — filings whose dt_posted is >60 days after the
 *     quarter end.
 *   - **Newly registered lobbyists** — the `lobbyists[].new` flag surfaces
 *     someone appearing in that filing for the first time on this client.
 *   - **Ex-staffer hires** — lobbyists whose `covered_position` names a
 *     specific member or committee. We don't infer cooling-off violations;
 *     we surface the disclosure.
 *   - **Issue churn** — quarters where the issue-code set changes sharply
 *     from the preceding quarter (Jaccard < 0.5).
 *   - **Govt-entity expansion** — quarters where the client started
 *     contacting a government body they hadn't before.
 *
 * Every finding is a flag, not an accusation, per CLAUDE.md rule #4.
 */

import type { LdaClient } from "../core/lda-client.ts";
import {
  listFilingsForClient,
  filingQuarter,
  filingHumanUrl,
  type Filing,
} from "../core/lda-endpoints.ts";
import { resolveClient } from "../core/resolve.ts";
import type { DbClient } from "../db/engine.ts";
import { upsertFilingsBatch } from "../db/repos.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";

export const SKILL_NAME = "anomaly-scan";
export const SCHEMA_VERSION = 1;

export interface AnomalyScanInput {
  client?: string;
  client_id?: number;
  year_start: number;
  year_end: number;
}

export type AnomalyKind =
  | "late_filing"
  | "new_lobbyist"
  | "ex_staffer_hire"
  | "issue_churn"
  | "new_govt_entity";

export interface AnomalyFlag {
  kind: AnomalyKind;
  severity: "info" | "notable" | "high";
  year: number;
  quarter: number | null;
  filing_uuid: string;
  filing_url: string;
  note: string;
  // Optional detail fields populated per kind
  lobbyist_name?: string;
  covered_position?: string;
  new_issue_codes?: string[];
  dropped_issue_codes?: string[];
  days_late?: number;
  govt_entity?: string;
}

export interface AnomalyScanData {
  client: { client_id: number; name: string };
  window: TimeWindow;
  totals: {
    filings_scanned: number;
    flags_raised: number;
    by_kind: Record<AnomalyKind, number>;
  };
  flags: AnomalyFlag[];
}

// ---------------------------------------------------------------------------

export async function runAnomalyScan(
  lda: LdaClient,
  db: DbClient,
  input: AnomalyScanInput,
): Promise<Brief<AnomalyScanData>> {
  let client_id = input.client_id;
  let client_name: string;
  if (client_id === undefined) {
    if (!input.client) throw new Error("anomaly-scan requires `client` or `client_id`.");
    const res = await resolveClient(db, lda, input.client);
    if (!res) throw new Error(`anomaly-scan: no LDA client matched "${input.client}".`);
    client_id = res.client_id;
    client_name = res.name;
  } else {
    client_name = `client #${client_id}`;
  }

  const filings = input.client_id !== undefined
    ? await listFilingsForClient(lda, {
        clientId: input.client_id,
        yearStart: input.year_start,
        yearEnd: input.year_end,
      })
    : await listFilingsForClient(lda, {
        clientName: input.client!,
        yearStart: input.year_start,
        yearEnd: input.year_end,
      });
  await upsertFilingsBatch(db, filings);
  if (filings[0]) client_name = filings[0].client.name;

  // Sort for time-series checks
  filings.sort((a, b) => {
    if (a.filing_year !== b.filing_year) return a.filing_year - b.filing_year;
    return (filingQuarter(a) ?? 0) - (filingQuarter(b) ?? 0);
  });

  const flags: AnomalyFlag[] = [];
  const prevIssueCodes = new Map<number, Set<string>>();
  // For new_govt_entity: track the cumulative govt-entity set up to (but
  // excluding) the current filing.
  let cumulativeGovt = new Set<string>();

  for (const f of filings) {
    const q = filingQuarter(f);
    const quarterEnd = q ? quarterEndDate(f.filing_year, q) : null;
    const dtPosted = f.dt_posted ? new Date(f.dt_posted) : null;

    // Late filing: >60 days after quarter end.
    if (quarterEnd && dtPosted && dtPosted.getTime() - quarterEnd.getTime() > 60 * 24 * 3600 * 1000) {
      const days = Math.floor((dtPosted.getTime() - quarterEnd.getTime()) / (24 * 3600 * 1000));
      flags.push({
        kind: "late_filing",
        severity: days > 180 ? "high" : "notable",
        year: f.filing_year,
        quarter: q,
        filing_uuid: f.filing_uuid,
        filing_url: filingHumanUrl(f),
        note: `Filed ${days} days after quarter end.`,
        days_late: days,
      });
    }

    // Per-activity checks
    const thisIssueCodes = new Set<string>();
    const thisGovt = new Set<string>();

    for (const a of f.lobbying_activities ?? []) {
      if (a.general_issue_code) thisIssueCodes.add(a.general_issue_code);
      for (const ge of a.government_entities ?? []) thisGovt.add(ge.name);
      for (const la of a.lobbyists ?? []) {
        const name = [la.lobbyist.first_name, la.lobbyist.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || `lobbyist #${la.lobbyist.id}`;

        if (la.new) {
          flags.push({
            kind: "new_lobbyist",
            severity: "info",
            year: f.filing_year,
            quarter: q,
            filing_uuid: f.filing_uuid,
            filing_url: filingHumanUrl(f),
            note: `New lobbyist registered on this filing: ${name}.`,
            lobbyist_name: name,
            covered_position: la.covered_position ?? undefined,
          });
        }

        const cp = la.covered_position?.trim();
        if (cp && /sen\.|senator|rep\.|representative|chief of staff|legislative|staff director|committee/i.test(cp)) {
          flags.push({
            kind: "ex_staffer_hire",
            severity: la.new ? "notable" : "info",
            year: f.filing_year,
            quarter: q,
            filing_uuid: f.filing_uuid,
            filing_url: filingHumanUrl(f),
            note: `Lobbyist ${name} discloses a covered government position: "${cp}".`,
            lobbyist_name: name,
            covered_position: cp,
          });
        }
      }
    }

    // Issue churn: Jaccard between this filing's issue set and the last
    // filing's issue set. Skipping if either is empty.
    const prevKey = (f.registrant.id << 0) | 0; // not used; we key the previous set on the client, which is fixed here
    const prev = prevIssueCodes.get(client_id) ?? null;
    if (prev !== null && prev.size > 0 && thisIssueCodes.size > 0) {
      const jacc = jaccard(prev, thisIssueCodes);
      if (jacc < 0.5) {
        const newCodes = [...thisIssueCodes].filter((c) => !prev.has(c));
        const droppedCodes = [...prev].filter((c) => !thisIssueCodes.has(c));
        flags.push({
          kind: "issue_churn",
          severity: jacc < 0.25 ? "notable" : "info",
          year: f.filing_year,
          quarter: q,
          filing_uuid: f.filing_uuid,
          filing_url: filingHumanUrl(f),
          note: `Issue-code overlap with previous filing is ${(jacc * 100).toFixed(0)}% (${newCodes.length} added, ${droppedCodes.length} dropped).`,
          new_issue_codes: newCodes,
          dropped_issue_codes: droppedCodes,
        });
      }
    }
    prevIssueCodes.set(client_id, thisIssueCodes);

    // New govt entity (relative to the cumulative set)
    for (const ge of thisGovt) {
      if (!cumulativeGovt.has(ge)) {
        flags.push({
          kind: "new_govt_entity",
          severity: "info",
          year: f.filing_year,
          quarter: q,
          filing_uuid: f.filing_uuid,
          filing_url: filingHumanUrl(f),
          note: `First-ever recorded contact with ${ge}.`,
          govt_entity: ge,
        });
      }
    }
    cumulativeGovt = new Set([...cumulativeGovt, ...thisGovt]);
  }

  const byKind: Record<AnomalyKind, number> = {
    late_filing: 0,
    new_lobbyist: 0,
    ex_staffer_hire: 0,
    issue_churn: 0,
    new_govt_entity: 0,
  };
  for (const f of flags) byKind[f.kind] += 1;

  const data: AnomalyScanData = {
    client: { client_id, name: client_name },
    window: { year_start: input.year_start, year_end: input.year_end },
    totals: { filings_scanned: filings.length, flags_raised: flags.length, by_kind: byKind },
    flags,
  };

  const citations = flags.slice(0, 15).map((f, idx) => ({
    key: `flag_${idx + 1}`,
    description: `${f.kind} (${f.year}${f.quarter ? ` Q${f.quarter}` : ""})`,
    source: "lda" as const,
    url: f.filing_url,
    source_id: f.filing_uuid,
    fetched_at: new Date().toISOString(),
  }));

  const entity: EntityId = { kind: "client", id: String(client_id), display: client_name };
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

function quarterEndDate(year: number, quarter: number): Date {
  const endMonth = [3, 6, 9, 12][quarter - 1]!;
  const endDay = endMonth === 3 || endMonth === 12 ? 31 : 30;
  return new Date(Date.UTC(year, endMonth - 1, endDay, 23, 59, 59));
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

function renderMarkdown(data: AnomalyScanData): string {
  const lines: string[] = [];
  lines.push(`## ${data.client.name} — Anomaly Scan`);
  lines.push("");
  if (data.totals.flags_raised === 0) {
    lines.push(
      `No anomaly flags raised across ${data.totals.filings_scanned} filings in ${data.window.year_start}–${data.window.year_end}.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `Scanned **${data.totals.filings_scanned}** filings in ${data.window.year_start}–${data.window.year_end} and raised **${data.totals.flags_raised}** flags.`,
  );
  lines.push("");
  lines.push(
    `- Late filings: ${data.totals.by_kind.late_filing}  \n- New lobbyists: ${data.totals.by_kind.new_lobbyist}  \n- Ex-staffer hires: ${data.totals.by_kind.ex_staffer_hire}  \n- Issue churn: ${data.totals.by_kind.issue_churn}  \n- New government entities: ${data.totals.by_kind.new_govt_entity}`,
  );

  const show = data.flags.slice(0, 25);
  if (show.length > 0) {
    lines.push("");
    lines.push("### Flags (most recent 25)");
    lines.push("");
    for (let i = 0; i < show.length; i++) {
      const f = show[i]!;
      const qlab = f.quarter ? ` Q${f.quarter}` : "";
      lines.push(
        `- **${f.kind.replace(/_/g, " ")}** (${f.severity}, ${f.year}${qlab}) — ${f.note} [flag_${i + 1}]`,
      );
    }
    if (data.flags.length > show.length) {
      lines.push("");
      lines.push(`_…and ${data.flags.length - show.length} more flags in the structured envelope._`);
    }
  }

  lines.push("");
  lines.push(
    "> Flags are suggestions, not accusations. Unusual ≠ improper. Anomalies are starting points for human review.",
  );
  return lines.join("\n");
}
