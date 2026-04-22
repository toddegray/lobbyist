/**
 * `lobbyist entity-profile "<client name>"` — CLI wrapper around the skill.
 *
 * Flags:
 *   --client-id=N       skip name resolution; use LDA client_id directly
 *   --year-start=YYYY   default: cfg.default_year_start
 *   --year-end=YYYY     default: cfg.default_year_end
 *   --quarter=1..4      narrow to one quarter across each year
 *   --format=md|json    default: md
 *   --write=path        write the brief to a file instead of stdout
 */

import { writeFile } from "node:fs/promises";
import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import { saveBrief, upsertEntity } from "../db/repos.ts";
import { runEntityProfile } from "../skills/entity-profile.ts";

interface Flags {
  client: string | undefined;
  client_id: number | undefined;
  year_start: number | undefined;
  year_end: number | undefined;
  quarter: 1 | 2 | 3 | 4 | undefined;
  format: "md" | "json";
  write: string | undefined;
}

function parseFlags(args: string[]): Flags {
  const getVal = (key: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${key}=`));
    return hit ? hit.slice(`--${key}=`.length) : undefined;
  };
  // First positional argument (not starting with --) is the client name.
  const positional = args.find((a) => !a.startsWith("--"));

  const cid = getVal("client-id");
  const ys = getVal("year-start");
  const ye = getVal("year-end");
  const q = getVal("quarter");
  const format = (getVal("format") ?? "md") as "md" | "json";

  return {
    client: positional,
    client_id: cid ? Number.parseInt(cid, 10) : undefined,
    year_start: ys ? Number.parseInt(ys, 10) : undefined,
    year_end: ye ? Number.parseInt(ye, 10) : undefined,
    quarter: q ? (Number.parseInt(q, 10) as 1 | 2 | 3 | 4) : undefined,
    format,
    write: getVal("write"),
  };
}

export async function runEntityProfileCli(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (!flags.client && flags.client_id === undefined) {
    console.error('usage: lobbyist entity-profile "<client name>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--quarter=1..4] [--format=md|json] [--write=path]');
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
    const brief = await runEntityProfile(lda, db, {
      client: flags.client,
      client_id: flags.client_id,
      year_start: flags.year_start ?? cfg.default_year_start,
      year_end: flags.year_end ?? cfg.default_year_end,
      quarter: flags.quarter,
    });

    await upsertEntity(db, {
      kind: brief.entity.kind,
      id: brief.entity.id,
      display: brief.entity.display,
      external_id: brief.entity.id,
    });
    await saveBrief(db, brief);

    const out =
      flags.format === "json"
        ? JSON.stringify(brief, null, 2) + "\n"
        : brief.markdown + "\n";
    if (flags.write) {
      await writeFile(flags.write, out);
      console.log(`wrote ${flags.write}`);
    } else {
      process.stdout.write(out);
    }
    return 0;
  } finally {
    await db.close();
  }
}
