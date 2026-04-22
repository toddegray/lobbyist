/**
 * `lobbyist revolving-door "<person>"` — CLI wrapper.
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import { runRevolvingDoor } from "../skills/revolving-door.ts";
import { emitBrief, getFirstPositional, getFlag, getIntFlag } from "./_shared.ts";

export async function runRevolvingDoorCli(args: string[]): Promise<number> {
  const person = getFirstPositional(args);
  const lobbyist_id = getIntFlag(args, "lobbyist-id");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const write = getFlag(args, "write");

  if (!person && lobbyist_id === undefined) {
    console.error('usage: lobbyist revolving-door "<person name>" [--lobbyist-id=N] [--year-start=Y] [--year-end=Y] [--format=md|json] [--write=path]');
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
    const brief = await runRevolvingDoor(lda, db, {
      person,
      lobbyist_id,
      year_start: getIntFlag(args, "year-start") ?? cfg.default_year_start,
      year_end: getIntFlag(args, "year-end") ?? cfg.default_year_end,
    });
    await emitBrief(db, brief, { format, write });
    return 0;
  } finally {
    await db.close();
  }
}
