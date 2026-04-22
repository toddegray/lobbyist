/**
 * `lobbyist brief "<client>"` — CLI wrapper for the brief composer.
 *
 * --with-contracts turns on the contract-trace section (LDA + USASpending).
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { UsaSpendingClient } from "../core/usaspending-client.ts";
import { openDb } from "../db/engine.ts";
import { runComposeBrief } from "../skills/brief.ts";
import { emitBrief, getFirstPositional, getFlag, getIntFlag } from "./_shared.ts";

export async function runBriefCli(args: string[]): Promise<number> {
  const client = getFirstPositional(args);
  const client_id = getIntFlag(args, "client-id");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const write = getFlag(args, "write");
  const includeContracts = args.includes("--with-contracts");

  if (!client && client_id === undefined) {
    console.error('usage: lobbyist brief "<client>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--with-contracts] [--format=md|json] [--write=path]');
    return 2;
  }

  const cfg = await resolveConfig();
  const lda = new LdaClient({
    apiKey: cfg.resolved_lda_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.lda_rate_limit_rps,
  });
  const usa = includeContracts
    ? new UsaSpendingClient({
        apiKey: cfg.usaspending_api_key,
        cacheDir: cfg.cache_dir,
        rateLimitRps: 2,
      })
    : null;
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    const brief = await runComposeBrief(lda, db, usa, {
      client,
      client_id,
      year_start: getIntFlag(args, "year-start") ?? cfg.default_year_start,
      year_end: getIntFlag(args, "year-end") ?? cfg.default_year_end,
      include_contract_trace: includeContracts,
    });
    await emitBrief(db, brief, { format, write });
    return 0;
  } finally {
    await db.close();
  }
}
