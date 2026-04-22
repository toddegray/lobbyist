/**
 * `lobbyist filing-diff "<client>" --from=2020-Q1 --to=2024-Q1` — CLI wrapper.
 *
 * Accepts windows in the form YYYY or YYYY-Qn. Both sides may be either
 * single quarters or year ranges.
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import { runFilingDiff } from "../skills/filing-diff.ts";
import type { TimeWindow } from "../core/types.ts";
import { emitBrief, getFirstPositional, getFlag, getIntFlag } from "./_shared.ts";

/**
 * Parse a window spec:
 *   "2024"          → year_start=year_end=2024, no quarter
 *   "2024-Q3"       → year=2024, quarter=3
 *   "2020-2024"     → year range
 */
function parseWindow(raw: string, label: string): TimeWindow {
  const qMatch = raw.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    const y = Number.parseInt(qMatch[1]!, 10);
    const q = Number.parseInt(qMatch[2]!, 10) as 1 | 2 | 3 | 4;
    return { year_start: y, year_end: y, quarter: q };
  }
  const rangeMatch = raw.match(/^(\d{4})-(\d{4})$/);
  if (rangeMatch) {
    const ys = Number.parseInt(rangeMatch[1]!, 10);
    const ye = Number.parseInt(rangeMatch[2]!, 10);
    if (ye < ys) throw new Error(`${label}: end < start`);
    return { year_start: ys, year_end: ye };
  }
  const yearMatch = raw.match(/^(\d{4})$/);
  if (yearMatch) {
    const y = Number.parseInt(yearMatch[1]!, 10);
    return { year_start: y, year_end: y };
  }
  throw new Error(`${label}: expected YYYY, YYYY-Qn, or YYYY-YYYY (got "${raw}")`);
}

export async function runFilingDiffCli(args: string[]): Promise<number> {
  const client = getFirstPositional(args);
  const client_id = getIntFlag(args, "client-id");
  const from = getFlag(args, "from");
  const to = getFlag(args, "to");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const write = getFlag(args, "write");

  if ((!client && client_id === undefined) || !from || !to) {
    console.error('usage: lobbyist filing-diff "<client>" [--client-id=N] --from=YYYY[-Qn] --to=YYYY[-Qn] [--format=md|json] [--write=path]');
    return 2;
  }

  let from_window: TimeWindow;
  let to_window: TimeWindow;
  try {
    from_window = parseWindow(from, "--from");
    to_window = parseWindow(to, "--to");
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const cfg = await resolveConfig();
  const lda = new LdaClient({
    apiKey: cfg.resolved_lda_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.lda_rate_limit_rps,
  });
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    const brief = await runFilingDiff(lda, db, {
      client,
      client_id,
      from_window,
      to_window,
    });
    await emitBrief(db, brief, { format, write });
    return 0;
  } finally {
    await db.close();
  }
}
