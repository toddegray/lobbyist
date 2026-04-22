/**
 * `lobbyist bill-watchers` — CLI wrapper.
 *
 * Flags (one of --bill or --issue-code required):
 *   --bill="HR 5376"      free-text match against filings' specific-issue field
 *   --issue-code=HCR      LDA general issue code
 *   --year-start=YYYY
 *   --year-end=YYYY
 *   --quarter=1..4
 *   --format=md|json
 *   --write=path
 */

import { writeFile } from "node:fs/promises";
import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import { saveBrief, upsertEntity } from "../db/repos.ts";
import { runBillWatchers } from "../skills/bill-watchers.ts";

export async function runBillWatchersCli(args: string[]): Promise<number> {
  const getVal = (key: string) => {
    const hit = args.find((a) => a.startsWith(`--${key}=`));
    return hit ? hit.slice(`--${key}=`.length) : undefined;
  };

  const bill = getVal("bill");
  const issue_code = getVal("issue-code");
  const ys = getVal("year-start");
  const ye = getVal("year-end");
  const q = getVal("quarter");
  const format = (getVal("format") ?? "md") as "md" | "json";
  const write = getVal("write");

  if (!bill && !issue_code) {
    console.error('usage: lobbyist bill-watchers --bill="HR 5376" OR --issue-code=HCR [--year-start=Y] [--year-end=Y] [--quarter=1..4] [--format=md|json] [--write=path]');
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
    const brief = await runBillWatchers(lda, db, {
      bill,
      issue_code,
      year_start: ys ? Number.parseInt(ys, 10) : cfg.default_year_start,
      year_end: ye ? Number.parseInt(ye, 10) : cfg.default_year_end,
      quarter: q ? (Number.parseInt(q, 10) as 1 | 2 | 3 | 4) : undefined,
    });

    await upsertEntity(db, {
      kind: brief.entity.kind,
      id: brief.entity.id,
      display: brief.entity.display,
    });
    await saveBrief(db, brief);

    const out =
      format === "json"
        ? JSON.stringify(brief, null, 2) + "\n"
        : brief.markdown + "\n";
    if (write) {
      await writeFile(write, out);
      console.log(`wrote ${write}`);
    } else {
      process.stdout.write(out);
    }
    return 0;
  } finally {
    await db.close();
  }
}
