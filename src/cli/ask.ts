/**
 * `lobbyist ask "<question>"` — natural-language dispatch.
 *
 * Needs an Anthropic API key (env ANTHROPIC_API_KEY or ~/.lobbyist/config.json).
 */

import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { OpenFecClient } from "../core/openfec-client.ts";
import { UsaSpendingClient } from "../core/usaspending-client.ts";
import { openDb } from "../db/engine.ts";
import { runAsk } from "../agents/ask.ts";
import { getFirstPositional, getIntFlag } from "./_shared.ts";

export async function runAskCli(args: string[]): Promise<number> {
  const question = getFirstPositional(args);
  if (!question) {
    console.error('usage: lobbyist ask "<natural-language question>" [--max-iterations=N] [--verbose] [--stats]');
    return 2;
  }
  const maxIter = getIntFlag(args, "max-iterations") ?? 8;
  const verbose = args.includes("--verbose");
  const showStats = args.includes("--stats");

  const cfg = await resolveConfig();
  if (!cfg.resolved_anthropic_key) {
    console.error("error: ask requires ANTHROPIC_API_KEY (env) or anthropic_api_key (config).");
    return 2;
  }

  const lda = new LdaClient({
    apiKey: cfg.resolved_lda_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.lda_rate_limit_rps,
  });
  const openfec = cfg.resolved_openfec_key
    ? new OpenFecClient({
        apiKey: cfg.resolved_openfec_key,
        cacheDir: cfg.cache_dir,
        rateLimitRps: cfg.openfec_rate_limit_rps,
      })
    : null;
  const usaspending = new UsaSpendingClient({
    apiKey: cfg.usaspending_api_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: 2,
  });
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    const res = await runAsk(
      { cfg, lda, openfec, usaspending, db },
      { question, maxIterations: maxIter, verbose },
    );
    process.stdout.write(res.answer + "\n");
    if (showStats) {
      process.stderr.write(
        `\n[ask] iterations=${res.iterations} tool_calls=${res.tool_calls.length} in=${res.input_tokens} out=${res.output_tokens} stop=${res.stop_reason}\n`,
      );
    }
    return 0;
  } finally {
    await db.close();
  }
}
