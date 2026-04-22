/**
 * `lobbyist coalition-detect` — CLI wrapper.
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import { runCoalitionDetect } from "../skills/coalition-detect.ts";
import { emitBrief, getFirstPositional, getFlag, getIntFlag } from "./_shared.ts";

export async function runCoalitionDetectCli(args: string[]): Promise<number> {
  const issue_code = getFlag(args, "issue-code");
  const bill = getFlag(args, "bill");
  const client_id = getIntFlag(args, "client-id");
  const client = getFirstPositional(args);
  const min_size = getIntFlag(args, "min-size");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const write = getFlag(args, "write");

  if (!issue_code && !bill && !client && client_id === undefined) {
    console.error('usage: lobbyist coalition-detect (--issue-code=HCR | --bill="<substring>" | "<client name>" | --client-id=N) [--year-start=Y] [--year-end=Y] [--min-size=N] [--format=md|json] [--write=path]');
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
    const brief = await runCoalitionDetect(lda, db, {
      issue_code,
      bill,
      client,
      client_id,
      year_start: getIntFlag(args, "year-start") ?? cfg.default_year_start,
      year_end: getIntFlag(args, "year-end") ?? cfg.default_year_end,
      min_coalition_size: min_size,
    });
    await emitBrief(db, brief, { format, write });
    return 0;
  } finally {
    await db.close();
  }
}
