/**
 * spend-analysis — quarter-over-quarter lobbying spend for a client.
 *
 * Given a client (by name or client_id) and a year range, produces:
 *   - per-quarter spend series
 *   - year-over-year totals with change
 *   - anomaly flags: any quarter whose spend is > 2x the trailing median
 *     (across the 8 preceding quarters), or a YoY jump > 2x.
 *
 * Anomaly flags are suggestions, not accusations. The brief is explicit
 * about that per CLAUDE.md rule #4.
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
import { fmtPct, fmtUsd } from "../core/types.ts";

export const SKILL_NAME = "spend-analysis";
export const SCHEMA_VERSION = 1;

export interface SpendAnalysisInput {
  client?: string;
  client_id?: number;
  year_start: number;
  year_end: number;
}

export interface SpendAnalysisData {
  client: { client_id: number; name: string };
  window: TimeWindow;
  quarterly_series: Array<{
    year: number;
    quarter: 1 | 2 | 3 | 4;
    spend: number;
    filing_uuid: string;
    filing_url: string;
  }>;
  annual_series: Array<{
    year: number;
    spend: number;
    filings: number;
    yoy_change: number | null;   // null for the first year in series
    yoy_change_pct: number | null;
  }>;
  totals: {
    all_years_spend: number;
    peak_year: { year: number; spend: number } | null;
    trough_year: { year: number; spend: number } | null;
    average_quarter_spend: number | null;
    median_quarter_spend: number | null;
  };
  anomaly_flags: Array<{
    kind: "quarterly_spike" | "yoy_jump" | "sudden_zero";
    year: number;
    quarter?: 1 | 2 | 3 | 4;
    value: number;
    baseline: number;
    ratio: number;
    note: string;
  }>;
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export async function runSpendAnalysis(
  lda: LdaClient,
  db: DbClient,
  input: SpendAnalysisInput,
): Promise<Brief<SpendAnalysisData>> {
  // Resolve client
  let client_id = input.client_id;
  let client_name: string;

  if (client_id === undefined) {
    if (!input.client) throw new Error("spend-analysis requires `client` or `client_id`.");
    const resolved = await resolveClient(db, lda, input.client);
    if (!resolved)
      throw new Error(`spend-analysis: no LDA client matched "${input.client}".`);
    client_id = resolved.client_id;
    client_name = resolved.name;
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

  const data = aggregate(filings, client_id, client_name, {
    year_start: input.year_start,
    year_end: input.year_end,
  });
  const citations = buildCitations(data);
  const window: TimeWindow = { year_start: input.year_start, year_end: input.year_end };
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
// Aggregation + anomaly detection
// ---------------------------------------------------------------------------

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function aggregate(
  filings: Filing[],
  client_id: number,
  client_name: string,
  window: { year_start: number; year_end: number },
): SpendAnalysisData {
  // Build quarterly + annual series
  const quarterMap = new Map<string, { year: number; quarter: 1 | 2 | 3 | 4; spend: number; filing: Filing }>();
  const annualMap = new Map<number, { spend: number; filings: number }>();

  for (const f of filings) {
    const spend = filingSpend(f) ?? 0;
    const q = filingQuarter(f);
    if (q) {
      const key = `${f.filing_year}-${q}`;
      const existing = quarterMap.get(key);
      if (!existing || (existing.spend === 0 && spend > 0)) {
        quarterMap.set(key, { year: f.filing_year, quarter: q, spend, filing: f });
      }
    }
    const yprev = annualMap.get(f.filing_year) ?? { spend: 0, filings: 0 };
    yprev.spend += spend;
    yprev.filings += 1;
    annualMap.set(f.filing_year, yprev);
  }

  const quarterly_series = [...quarterMap.values()]
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter)
    .map((q) => ({
      year: q.year,
      quarter: q.quarter,
      spend: q.spend,
      filing_uuid: q.filing.filing_uuid,
      filing_url: filingHumanUrl(q.filing),
    }));

  const annualYears = [...annualMap.keys()].sort((a, b) => a - b);
  const annual_series = annualYears.map((year, idx) => {
    const yr = annualMap.get(year)!;
    const prev = idx > 0 ? annualMap.get(annualYears[idx - 1]!)!.spend : null;
    const yoy_change = prev === null ? null : yr.spend - prev;
    const yoy_change_pct =
      prev === null || prev === 0 ? null : (yr.spend - prev) / prev;
    return {
      year,
      spend: yr.spend,
      filings: yr.filings,
      yoy_change,
      yoy_change_pct,
    };
  });

  const quarterSpends = quarterly_series.map((q) => q.spend);
  const annualSpends = annual_series.map((y) => y.spend);
  let peak_year: SpendAnalysisData["totals"]["peak_year"] = null;
  let trough_year: SpendAnalysisData["totals"]["trough_year"] = null;
  if (annual_series.length > 0) {
    const peak = annual_series.reduce((a, b) => (b.spend > a.spend ? b : a));
    const trough = annual_series.reduce((a, b) => (b.spend < a.spend ? b : a));
    peak_year = { year: peak.year, spend: peak.spend };
    trough_year = { year: trough.year, spend: trough.spend };
  }

  const totals = {
    all_years_spend: annualSpends.reduce((a, b) => a + b, 0),
    peak_year,
    trough_year,
    average_quarter_spend:
      quarterSpends.length > 0
        ? quarterSpends.reduce((a, b) => a + b, 0) / quarterSpends.length
        : null,
    median_quarter_spend: median(quarterSpends),
  };

  // Anomaly pass
  const anomaly_flags: SpendAnalysisData["anomaly_flags"] = [];

  // Quarterly spikes: any quarter > 2x the median of its preceding 8 quarters.
  for (let i = 0; i < quarterly_series.length; i++) {
    const trailing = quarterly_series
      .slice(Math.max(0, i - 8), i)
      .map((q) => q.spend)
      .filter((s) => s > 0);
    const m = median(trailing);
    if (m !== null && m > 0 && quarterly_series[i]!.spend > 2 * m) {
      const q = quarterly_series[i]!;
      anomaly_flags.push({
        kind: "quarterly_spike",
        year: q.year,
        quarter: q.quarter,
        value: q.spend,
        baseline: m,
        ratio: q.spend / m,
        note: `Q${q.quarter} ${q.year} spend of ${fmtUsd(q.spend)} is ${(q.spend / m).toFixed(1)}× the trailing median of ${fmtUsd(m)}.`,
      });
    }
  }

  // YoY jumps: any year's spend > 2x the previous year's spend (and both non-zero).
  for (let i = 1; i < annual_series.length; i++) {
    const prev = annual_series[i - 1]!.spend;
    const cur = annual_series[i]!.spend;
    if (prev > 0 && cur > 2 * prev) {
      anomaly_flags.push({
        kind: "yoy_jump",
        year: annual_series[i]!.year,
        value: cur,
        baseline: prev,
        ratio: cur / prev,
        note: `${annual_series[i]!.year} spend of ${fmtUsd(cur)} is ${(cur / prev).toFixed(1)}× the prior year's ${fmtUsd(prev)}.`,
      });
    }
  }

  // Sudden zeros: a quarter with zero spend when surrounding quarters averaged >0.
  for (let i = 1; i < quarterly_series.length - 1; i++) {
    const q = quarterly_series[i]!;
    const neighborAvg = (quarterly_series[i - 1]!.spend + quarterly_series[i + 1]!.spend) / 2;
    if (q.spend === 0 && neighborAvg > 0) {
      anomaly_flags.push({
        kind: "sudden_zero",
        year: q.year,
        quarter: q.quarter,
        value: 0,
        baseline: neighborAvg,
        ratio: 0,
        note: `Q${q.quarter} ${q.year} reported $0 while neighboring quarters averaged ${fmtUsd(neighborAvg)}.`,
      });
    }
  }

  return {
    client: { client_id, name: client_name },
    window: { year_start: window.year_start, year_end: window.year_end },
    quarterly_series,
    annual_series,
    totals,
    anomaly_flags,
  };
}

// ---------------------------------------------------------------------------
// Citations + narrative
// ---------------------------------------------------------------------------

function buildCitations(data: SpendAnalysisData): Citation[] {
  const cites: Citation[] = [];
  const fetched_at = new Date().toISOString();
  for (const q of data.quarterly_series) {
    cites.push({
      key: `q${q.year}_${q.quarter}`,
      description: `Q${q.quarter} ${q.year} filing for ${data.client.name}: ${fmtUsd(q.spend)}`,
      source: "lda",
      url: q.filing_url,
      source_id: q.filing_uuid,
      fetched_at,
    });
  }
  return cites;
}

function renderMarkdown(data: SpendAnalysisData, window: TimeWindow): string {
  const years = `${window.year_start}–${window.year_end}`;
  const lines: string[] = [];
  lines.push(`## ${data.client.name} — Lobbying Spend Analysis`);
  lines.push("");
  if (data.quarterly_series.length === 0 && data.annual_series.length === 0) {
    lines.push(`No LDA spend recorded for ${data.client.name} in ${years}.`);
    return lines.join("\n");
  }
  lines.push(
    `Total reported spend across ${years}: **${fmtUsd(data.totals.all_years_spend)}** across ${data.quarterly_series.length} ${data.quarterly_series.length === 1 ? "quarter" : "quarters"} of activity.`,
  );
  if (data.totals.peak_year) {
    lines.push(
      `- Peak year: **${data.totals.peak_year.year}** (${fmtUsd(data.totals.peak_year.spend)}).`,
    );
  }
  if (data.totals.trough_year) {
    lines.push(
      `- Lowest year: ${data.totals.trough_year.year} (${fmtUsd(data.totals.trough_year.spend)}).`,
    );
  }
  if (data.totals.median_quarter_spend !== null) {
    lines.push(
      `- Median quarter: ${fmtUsd(data.totals.median_quarter_spend)}.`,
    );
  }

  if (data.annual_series.length > 0) {
    lines.push("");
    lines.push("### Year over year");
    lines.push("");
    lines.push("| Year | Spend | YoY change |");
    lines.push("| ---- | ----- | ---------- |");
    for (const y of data.annual_series) {
      const yoy =
        y.yoy_change_pct === null
          ? "—"
          : `${y.yoy_change! >= 0 ? "+" : ""}${fmtUsd(y.yoy_change!)} (${y.yoy_change_pct >= 0 ? "+" : ""}${fmtPct(y.yoy_change_pct)})`;
      lines.push(`| ${y.year} | ${fmtUsd(y.spend)} | ${yoy} |`);
    }
  }

  if (data.anomaly_flags.length > 0) {
    lines.push("");
    lines.push("### Anomaly flags (suggestions, not accusations)");
    lines.push("");
    for (const a of data.anomaly_flags) {
      const cite = a.quarter ? ` [q${a.year}_${a.quarter}]` : "";
      lines.push(`- **${a.kind.replace(/_/g, " ")}** — ${a.note}${cite}`);
    }
  }

  lines.push("");
  lines.push(
    "> Quarterly spend is what the filer reported to the Senate. Filers sometimes amend months later — check the filing URL for the authoritative version.",
  );
  return lines.join("\n");
}
