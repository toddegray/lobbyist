/**
 * `lobbyist ping` — sanity-check the configured LDA key.
 *
 * Fires a tiny request against /api/v1/filings/ and reports whether auth
 * worked, how long the round-trip took, and how many filings the LDA knows
 * about in total (the count field on the list endpoint).
 */

import { z } from "zod";
import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";

const PingPage = z
  .object({
    count: z.number().int(),
  })
  .passthrough();

export async function runPing(_args: string[]): Promise<number> {
  const cfg = await resolveConfig();
  const client = new LdaClient({
    apiKey: cfg.resolved_lda_key,
    cacheDir: cfg.cache_dir,
    rateLimitRps: cfg.lda_rate_limit_rps,
    cacheTtlSeconds: 0, // always hit the network for ping
  });

  const start = Date.now();
  try {
    const page = await client.get(
      "/filings/",
      { page_size: 1 },
      PingPage,
      { bypassCache: true },
    );
    const ms = Date.now() - start;
    console.log(`ok — LDA API reachable in ${ms}ms.`);
    console.log(`  total filings in system: ${page.count.toLocaleString("en-US")}`);
    console.log(`  config source:           ${cfg.source_path ?? "(env only)"}`);
    return 0;
  } catch (e) {
    const ms = Date.now() - start;
    console.error(`ping failed after ${ms}ms:`);
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
