/**
 * `lobbyist config [--reveal]` — show the resolved configuration.
 *
 * Mask API keys by default; `--reveal` shows them plain for piping into
 * another tool. Never display in a format that would accidentally land in
 * a log aggregator.
 */

import { resolveConfig } from "../core/config.ts";

function mask(key: string | null): string {
  if (!key) return "(unset)";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export async function runShowConfig(args: string[]): Promise<number> {
  const reveal = args.includes("--reveal");
  const cfg = await resolveConfig();

  console.log(`config source:        ${cfg.source_path ?? "(env only)"}`);
  console.log(`operator:             ${cfg.operator.name} <${cfg.operator.email}>`);
  console.log(
    `lda_api_key:          ${reveal ? cfg.resolved_lda_key : mask(cfg.resolved_lda_key)}`,
  );
  console.log(
    `openfec_api_key:      ${reveal ? (cfg.resolved_openfec_key ?? "(unset)") : mask(cfg.resolved_openfec_key)}`,
  );
  console.log(
    `anthropic_api_key:    ${reveal ? (cfg.resolved_anthropic_key ?? "(unset)") : mask(cfg.resolved_anthropic_key)}`,
  );
  console.log(`cache_dir:            ${cfg.cache_dir}`);
  console.log(`data_dir:             ${cfg.data_dir}`);
  console.log(`lda_rate_limit_rps:   ${cfg.lda_rate_limit_rps}`);
  console.log(`openfec_rate_limit_rps: ${cfg.openfec_rate_limit_rps}`);
  console.log(`default year range:   ${cfg.default_year_start}–${cfg.default_year_end}`);
  if (cfg.watchlist.length) console.log(`watchlist:            ${cfg.watchlist.join(", ")}`);
  return 0;
}
