/**
 * `lobbyist committee-influence --member="Jon Tester" --issue-codes=HCR,MMM --cycle=2024` — CLI wrapper.
 *
 * Requires both LDA and OpenFEC keys.
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { OpenFecClient } from "../core/openfec-client.ts";
import { openDb } from "../db/engine.ts";
import { runCommitteeInfluence } from "../skills/committee-influence.ts";
import { emitBrief, getFlag, getIntFlag } from "./_shared.ts";

export async function runCommitteeInfluenceCli(args: string[]): Promise<number> {
  const member = getFlag(args, "member");
  const candidate_id = getFlag(args, "candidate-id");
  const codesRaw = getFlag(args, "issue-codes");
  const cycle = getIntFlag(args, "cycle");
  const topN = getIntFlag(args, "top-n-clients");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const write = getFlag(args, "write");

  if ((!member && !candidate_id) || !codesRaw) {
    console.error('usage: lobbyist committee-influence (--member="<name>" | --candidate-id=S######) --issue-codes=HCR[,MMM,…] [--cycle=YYYY] [--year-start=Y] [--year-end=Y] [--top-n-clients=N] [--format=md|json] [--write=path]');
    return 2;
  }
  const issue_codes = codesRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (issue_codes.length === 0) {
    console.error("error: --issue-codes must include at least one code, e.g. HCR");
    return 2;
  }

  const cfg = await resolveConfig();
  if (!cfg.resolved_openfec_key) {
    console.error("error: committee-influence requires an OpenFEC API key. Add one via `lobbyist init --force` or set LOBBYIST_OPENFEC_API_KEY.");
    return 2;
  }
  const lda = new LdaClient({
    apiKey: cfg.resolved_lda_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.lda_rate_limit_rps,
  });
  const fec = new OpenFecClient({
    apiKey: cfg.resolved_openfec_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.openfec_rate_limit_rps,
  });
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    const brief = await runCommitteeInfluence(lda, fec, db, {
      member,
      candidate_id,
      issue_codes,
      year_start: getIntFlag(args, "year-start") ?? cfg.default_year_start,
      year_end: getIntFlag(args, "year-end") ?? cfg.default_year_end,
      cycle: cycle ?? cfg.default_year_end,
      top_n_clients: topN,
    });
    await emitBrief(db, brief, { format, write });
    return 0;
  } finally {
    await db.close();
  }
}
