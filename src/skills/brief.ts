/**
 * brief — compose a full narrative brief from multiple skills.
 *
 * Given a client, runs entity-profile + spend-analysis + anomaly-scan (and
 * contract-trace if a USASpending client is available) and concatenates
 * the results into a single shareable markdown document.
 *
 * This is composition, not LLM synthesis. Every section is a skill's
 * literal markdown output. If the user also has Anthropic configured and
 * passes --synthesize, the `ask` orchestrator (not this skill) wraps a
 * narrative intro around the raw sections.
 *
 * The brief skill is the v0.5 "give me everything for this client" button.
 */

import type { LdaClient } from "../core/lda-client.ts";
import type { UsaSpendingClient } from "../core/usaspending-client.ts";
import type { DbClient } from "../db/engine.ts";
import { runEntityProfile } from "./entity-profile.ts";
import { runSpendAnalysis } from "./spend-analysis.ts";
import { runAnomalyScan } from "./anomaly-scan.ts";
import { runContractTrace } from "./contract-trace.ts";
import type { Brief, Citation, EntityId, TimeWindow } from "../core/types.ts";

export const SKILL_NAME = "brief";
export const SCHEMA_VERSION = 1;

export interface ComposeBriefInput {
  client?: string;
  client_id?: number;
  year_start: number;
  year_end: number;
  /** Optional; enables contract-trace section. */
  include_contract_trace?: boolean;
}

export interface ComposeBriefData {
  client: { client_id: number; name: string };
  window: TimeWindow;
  sections: Array<{
    skill: string;
    markdown: string;
    summary: string;
  }>;
  included: {
    entity_profile: boolean;
    spend_analysis: boolean;
    anomaly_scan: boolean;
    contract_trace: boolean;
  };
}

// ---------------------------------------------------------------------------

export async function runComposeBrief(
  lda: LdaClient,
  db: DbClient,
  usa: UsaSpendingClient | null,
  input: ComposeBriefInput,
): Promise<Brief<ComposeBriefData>> {
  if (!input.client && input.client_id === undefined) {
    throw new Error("brief requires `client` or `client_id`.");
  }
  const window = { year_start: input.year_start, year_end: input.year_end };

  const sections: ComposeBriefData["sections"] = [];
  const citations: Citation[] = [];

  // 1. entity-profile
  const profile = await runEntityProfile(lda, db, {
    client: input.client,
    client_id: input.client_id,
    year_start: input.year_start,
    year_end: input.year_end,
  });
  sections.push({
    skill: profile.skill,
    markdown: profile.markdown,
    summary: profileSummary(profile.data),
  });
  citations.push(...profile.citations);
  // The profile resolves the client; downstream skills can use its id.
  const client_id = Number.parseInt(profile.entity.id, 10);
  const client_name = profile.entity.display;

  // 2. spend-analysis
  const spend = await runSpendAnalysis(lda, db, {
    client_id,
    year_start: input.year_start,
    year_end: input.year_end,
  });
  sections.push({
    skill: spend.skill,
    markdown: spend.markdown,
    summary: `Spend analysis: ${spend.data.annual_series.length} year(s), ${spend.data.anomaly_flags.length} flag(s).`,
  });
  citations.push(...spend.citations);

  // 3. anomaly-scan
  const anomaly = await runAnomalyScan(lda, db, {
    client_id,
    year_start: input.year_start,
    year_end: input.year_end,
  });
  sections.push({
    skill: anomaly.skill,
    markdown: anomaly.markdown,
    summary: `Anomaly scan: ${anomaly.data.totals.flags_raised} flag(s) across ${anomaly.data.totals.filings_scanned} filings.`,
  });
  citations.push(...anomaly.citations);

  // 4. contract-trace (optional)
  let contractTraceIncluded = false;
  if (input.include_contract_trace && usa) {
    try {
      const trace = await runContractTrace(lda, usa, db, {
        client_id,
        year_start: input.year_start,
        year_end: input.year_end,
      });
      sections.push({
        skill: trace.skill,
        markdown: trace.markdown,
        summary: `Contract trace: ${trace.data.usaspending.awards_returned} awards, ratio ${trace.data.derived.contracts_per_dollar_lobbied?.toFixed(2) ?? "n/a"}.`,
      });
      citations.push(...trace.citations);
      contractTraceIncluded = true;
    } catch (e) {
      // Contract trace is best-effort. If USASpending is down or returns
      // nothing useful, we still ship the rest.
      sections.push({
        skill: "contract-trace",
        markdown: `\n> contract-trace skipped: ${e instanceof Error ? e.message : String(e)}`,
        summary: "contract-trace skipped",
      });
    }
  }

  const data: ComposeBriefData = {
    client: { client_id, name: client_name },
    window,
    sections,
    included: {
      entity_profile: true,
      spend_analysis: true,
      anomaly_scan: true,
      contract_trace: contractTraceIncluded,
    },
  };

  const markdown = renderMarkdown(data);
  const entity: EntityId = { kind: "client", id: String(client_id), display: client_name };

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

function profileSummary(d: {
  totals: { filings: number; total_spend: number; quarters_with_activity: number };
  client: { name: string };
}): string {
  return `${d.totals.filings} filings, $${d.totals.total_spend.toLocaleString()} spend.`;
}

function renderMarkdown(data: ComposeBriefData): string {
  const lines: string[] = [];
  lines.push(`# ${data.client.name} — Full Brief (${data.window.year_start}–${data.window.year_end})`);
  lines.push("");
  lines.push(
    `This brief composes ${data.sections.length} skill outputs: ${Object.entries(data.included)
      .filter(([, v]) => v)
      .map(([k]) => "`" + k + "`")
      .join(", ")}. Every claim inside each section cites its source filing.`,
  );
  lines.push("");
  lines.push("---");
  for (const s of data.sections) {
    lines.push("");
    lines.push(s.markdown.trim());
    lines.push("");
    lines.push("---");
  }
  lines.push("");
  lines.push(
    "> Composed brief: each section is the verbatim output of its skill. Derived analysis (ratios, anomalies) is labeled as such inside its section.",
  );
  return lines.join("\n");
}
