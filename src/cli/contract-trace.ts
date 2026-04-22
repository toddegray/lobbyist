/**
 * `lobbyist contract-trace "<client name>"` — CLI wrapper.
 * LDA + USASpending.gov join.
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { UsaSpendingClient } from "../core/usaspending-client.ts";
import { openDb } from "../db/engine.ts";
import { runContractTrace } from "../skills/contract-trace.ts";
import { emitBrief, getFirstPositional, getFlag, getIntFlag } from "./_shared.ts";

export async function runContractTraceCli(args: string[]): Promise<number> {
  const client = getFirstPositional(args);
  const client_id = getIntFlag(args, "client-id");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const write = getFlag(args, "write");
  const recipient = getFlag(args, "usaspending-recipient");

  if (!client && client_id === undefined) {
    console.error('usage: lobbyist contract-trace "<client name>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--usaspending-recipient="exact recipient"] [--format=md|json] [--write=path]');
    return 2;
  }

  const cfg = await resolveConfig();
  const lda = new LdaClient({
    apiKey: cfg.resolved_lda_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.lda_rate_limit_rps,
  });
  const usa = new UsaSpendingClient({
    apiKey: cfg.usaspending_api_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: 2,
  });
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    const brief = await runContractTrace(lda, usa, db, {
      client,
      client_id,
      year_start: getIntFlag(args, "year-start") ?? cfg.default_year_start,
      year_end: getIntFlag(args, "year-end") ?? cfg.default_year_end,
      usaspending_recipient: recipient,
    });
    await emitBrief(db, brief, { format, write });
    return 0;
  } finally {
    await db.close();
  }
}
