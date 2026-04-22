/**
 * `lobbyist anomaly-scan "<client>"` — CLI wrapper.
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import { runAnomalyScan } from "../skills/anomaly-scan.ts";
import { emitBrief, getFirstPositional, getFlag, getIntFlag } from "./_shared.ts";

export async function runAnomalyScanCli(args: string[]): Promise<number> {
  const client = getFirstPositional(args);
  const client_id = getIntFlag(args, "client-id");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const write = getFlag(args, "write");

  if (!client && client_id === undefined) {
    console.error('usage: lobbyist anomaly-scan "<client>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--format=md|json] [--write=path]');
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
    const brief = await runAnomalyScan(lda, db, {
      client,
      client_id,
      year_start: getIntFlag(args, "year-start") ?? cfg.default_year_start,
      year_end: getIntFlag(args, "year-end") ?? cfg.default_year_end,
    });
    await emitBrief(db, brief, { format, write });
    return 0;
  } finally {
    await db.close();
  }
}
