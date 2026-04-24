/**
 * `lobbyist bill-watchers` — CLI wrapper.
 *
 * Flags (one of --bill, --issue-code, or --congress-bill required):
 *   --bill="CHIPS Act"               LDA substring match on specific-issue field
 *   --issue-code=HCR                 LDA general issue code
 *   --congress-bill=CONGRESS/TYPE/N  Congress.gov exact reference, e.g.
 *                                    --congress-bill=117/HR/4346 for CHIPS Act.
 *                                    Enriches output with bill title, sponsor,
 *                                    introduced date, latest action, and
 *                                    committees of jurisdiction. Requires a
 *                                    configured Congress.gov / OpenFEC key.
 *   --year-start=YYYY
 *   --year-end=YYYY
 *   --quarter=1..4
 *   --format=md|json
 *   --write=path
 */

import { writeFile } from "node:fs/promises";
import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { CongressClient } from "../core/congress-client.ts";
import { openDb } from "../db/engine.ts";
import { saveBrief, upsertEntity } from "../db/repos.ts";
import { runBillWatchers } from "../skills/bill-watchers.ts";

/**
 * Parse `117/HR/4346` (or `117-HR-4346`) into structured form.
 * Accepts `/` or `-` separators; validates the pieces.
 */
function parseCongressBill(
  raw: string,
): { congress: number; type: string; number: string } | null {
  const parts = raw.split(/[/-]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  const congress = Number.parseInt(parts[0]!, 10);
  const type = parts[1]!.toUpperCase();
  const number = parts[2]!;
  if (!Number.isFinite(congress) || congress < 1 || congress > 200) return null;
  if (!/^[A-Z]+$/.test(type)) return null;
  if (!/^\d+$/.test(number)) return null;
  return { congress, type, number };
}

export async function runBillWatchersCli(args: string[]): Promise<number> {
  const getVal = (key: string) => {
    const hit = args.find((a) => a.startsWith(`--${key}=`));
    return hit ? hit.slice(`--${key}=`.length) : undefined;
  };

  const bill = getVal("bill");
  const issue_code = getVal("issue-code");
  const congressBillRaw = getVal("congress-bill");
  const ys = getVal("year-start");
  const ye = getVal("year-end");
  const q = getVal("quarter");
  const format = (getVal("format") ?? "md") as "md" | "json";
  const write = getVal("write");

  if (!bill && !issue_code && !congressBillRaw) {
    console.error(
      'usage: lobbyist bill-watchers (--bill="<substring>" | --issue-code=HCR | --congress-bill=CONGRESS/TYPE/NUMBER) [--year-start=Y] [--year-end=Y] [--quarter=1..4] [--format=md|json] [--write=path]\n' +
        "  e.g. lobbyist bill-watchers --congress-bill=117/HR/4346 --year-start=2021 --year-end=2023",
    );
    return 2;
  }

  let congress_bill: { congress: number; type: string; number: string } | undefined;
  if (congressBillRaw) {
    const parsed = parseCongressBill(congressBillRaw);
    if (!parsed) {
      console.error(
        `error: --congress-bill must look like CONGRESS/TYPE/NUMBER (e.g. 117/HR/4346). Got: "${congressBillRaw}"`,
      );
      return 2;
    }
    congress_bill = parsed;
  }

  const cfg = await resolveConfig();
  const lda = new LdaClient({
    apiKey: cfg.resolved_lda_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.lda_rate_limit_rps,
  });
  const congress = cfg.resolved_congress_key
    ? new CongressClient({
        apiKey: cfg.resolved_congress_key,
        cacheDir: cfg.cache_dir,
        rateLimitRps: 1,
      })
    : null;
  if (congress_bill && !congress) {
    console.error(
      "error: --congress-bill requires a Congress.gov or OpenFEC (api.data.gov) API key. Run `lobbyist init --force` or set LOBBYIST_CONGRESS_API_KEY / LOBBYIST_OPENFEC_API_KEY.",
    );
    return 2;
  }
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    const brief = await runBillWatchers(
      lda,
      db,
      {
        bill,
        issue_code,
        congress_bill,
        year_start: ys ? Number.parseInt(ys, 10) : cfg.default_year_start,
        year_end: ye ? Number.parseInt(ye, 10) : cfg.default_year_end,
        quarter: q ? (Number.parseInt(q, 10) as 1 | 2 | 3 | 4) : undefined,
      },
      congress,
    );

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
