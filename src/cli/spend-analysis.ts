/**
 * `lobbyist spend-analysis "<client name>"` — CLI wrapper.
 */

import { writeFile } from "node:fs/promises";
import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import { saveBrief, upsertEntity } from "../db/repos.ts";
import { runSpendAnalysis } from "../skills/spend-analysis.ts";

export async function runSpendAnalysisCli(args: string[]): Promise<number> {
  const getVal = (key: string) => {
    const hit = args.find((a) => a.startsWith(`--${key}=`));
    return hit ? hit.slice(`--${key}=`.length) : undefined;
  };
  const positional = args.find((a) => !a.startsWith("--"));

  const cid = getVal("client-id");
  const ys = getVal("year-start");
  const ye = getVal("year-end");
  const format = (getVal("format") ?? "md") as "md" | "json";
  const write = getVal("write");

  if (!positional && !cid) {
    console.error('usage: lobbyist spend-analysis "<client name>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--format=md|json] [--write=path]');
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
    const brief = await runSpendAnalysis(lda, db, {
      client: positional,
      client_id: cid ? Number.parseInt(cid, 10) : undefined,
      year_start: ys ? Number.parseInt(ys, 10) : cfg.default_year_start,
      year_end: ye ? Number.parseInt(ye, 10) : cfg.default_year_end,
    });

    await upsertEntity(db, {
      kind: brief.entity.kind,
      id: brief.entity.id,
      display: brief.entity.display,
      external_id: brief.entity.id,
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
