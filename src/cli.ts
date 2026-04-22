#!/usr/bin/env bun
/**
 * lobbyist CLI entry.
 *
 * Each skill gets its own top-level command. `ask` is the natural-language
 * orchestrator. `mcp` hands off to the MCP stdio server.
 */

import { runInit } from "./cli/init.ts";
import { runShowConfig } from "./cli/show-config.ts";
import { runPing } from "./cli/ping.ts";
import { runEntityProfileCli } from "./cli/entity-profile.ts";
import { runBillWatchersCli } from "./cli/bill-watchers.ts";
import { runSpendAnalysisCli } from "./cli/spend-analysis.ts";
import { runRevolvingDoorCli } from "./cli/revolving-door.ts";
import { runCommitteeInfluenceCli } from "./cli/committee-influence.ts";
import { runContractTraceCli } from "./cli/contract-trace.ts";
import { runCoalitionDetectCli } from "./cli/coalition-detect.ts";
import { runFilingDiffCli } from "./cli/filing-diff.ts";
import { runAnomalyScanCli } from "./cli/anomaly-scan.ts";
import { runBriefCli } from "./cli/brief.ts";
import { runRecallCli } from "./cli/recall.ts";
import { runAnnotateCli } from "./cli/annotate.ts";
import { runWatchCli } from "./cli/watch.ts";
import { runAskCli } from "./cli/ask.ts";

const USAGE = `lobbyist — AI senior lobbying analyst

usage: lobbyist <command> [args]

setup:
  init                                    Interactive first-run setup (writes ~/.lobbyist/config.json)
  init --non-interactive --name=... --email=... --lda-key=...
                                          Non-interactive init for CI/headless use
  config [--reveal]                       Show the current resolved configuration
  ping                                    Sanity-check the configured LDA key

lda-only skills:
  entity-profile "<client>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--quarter=1..4] [--format=md|json] [--write=path]
                                          Full lobbying profile for a company or trade association.
  bill-watchers --bill="<substring>" OR --issue-code=HCR [--year-start=Y] [--year-end=Y] [--quarter=1..4]
                                          Clients lobbying on a given bill or issue code.
  spend-analysis "<client>" [--client-id=N] [--year-start=Y] [--year-end=Y]
                                          Quarter-over-quarter spend with anomaly flags.
  revolving-door "<person>" [--lobbyist-id=N] [--year-start=Y] [--year-end=Y]
                                          Career arc: covered positions, clients, firms.
  coalition-detect (--issue-code=HCR | --bill="<substring>" | "<client>" | --client-id=N) [--year-start=Y] [--year-end=Y] [--min-size=N]
                                          Detect entities lobbying together (shared firm, issue, quarter).
  filing-diff "<client>" [--client-id=N] --from=YYYY[-Qn] --to=YYYY[-Qn]
                                          Added/dropped lobbyists, issues, firms, govt entities + spend Δ.
  anomaly-scan "<client>" [--client-id=N] [--year-start=Y] [--year-end=Y]
                                          Late filings, new lobbyists, ex-staffer hires, issue churn.

cross-reference skills (require additional keys):
  committee-influence --member="<name>" OR --candidate-id=S###### --issue-codes=HCR[,MMM] [--cycle=YYYY] [--year-start=Y] [--year-end=Y] [--top-n-clients=N]
                                          LDA+FEC join: top lobbying clients + parallel FEC contributions to member's campaign. Requires OpenFEC key.
  contract-trace "<client>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--usaspending-recipient="exact name"]
                                          LDA+USASpending join: lobbying spend vs federal contract awards.

composition:
  brief "<client>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--with-contracts]
                                          Runs entity-profile + spend-analysis + anomaly-scan (+ contract-trace) and concatenates.

natural language:
  ask "<question>" [--max-iterations=N] [--verbose] [--stats]
                                          Claude picks the right tools and composes a narrative. Requires ANTHROPIC_API_KEY.

mcp:
  mcp                                     Start the lobbyist MCP stdio server.

memory:
  recall [<entity>] [--kind=...] [--skill=...] [--brief] [--format=md|json]
                                          Show stored briefs + annotations for an entity.
  annotate <entity> "<note>" [--kind=client|registrant|lobbyist|member]
                                          Attach a free-text note to an entity.
  watch --add=<entity_id> [--window=KEY]
  watch --remove=<entity_id>
  watch --list
  watch [--once | --interval-minutes=N]   Re-run entity-profile for every watchlist entry and write a digest to ~/.lobbyist/digests/.

env (overrides the config file when set):
  LOBBYIST_LDA_API_KEY       Senate LDA API token
  LOBBYIST_OPENFEC_API_KEY   OpenFEC / api.data.gov key (enables committee-influence)
  LOBBYIST_CONGRESS_API_KEY  Congress.gov API key (falls back to LOBBYIST_OPENFEC_API_KEY)
  LOBBYIST_CONFIG_PATH       override path to config.json
  LOBBYIST_CACHE_DIR         override response cache dir
  LOBBYIST_DATA_DIR          override SQLite data dir
  ANTHROPIC_API_KEY          Anthropic key for ask orchestrator

`;

async function main(argv: string[]): Promise<number> {
  const [, , command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "init":
      return runInit(rest);
    case "config":
      return runShowConfig(rest);
    case "ping":
      return runPing(rest);
    case "entity-profile":
      return runEntityProfileCli(rest);
    case "bill-watchers":
      return runBillWatchersCli(rest);
    case "spend-analysis":
      return runSpendAnalysisCli(rest);
    case "revolving-door":
      return runRevolvingDoorCli(rest);
    case "committee-influence":
      return runCommitteeInfluenceCli(rest);
    case "contract-trace":
      return runContractTraceCli(rest);
    case "coalition-detect":
      return runCoalitionDetectCli(rest);
    case "filing-diff":
      return runFilingDiffCli(rest);
    case "anomaly-scan":
      return runAnomalyScanCli(rest);
    case "brief":
      return runBriefCli(rest);
    case "ask":
      return runAskCli(rest);
    case "recall":
      return runRecallCli(rest);
    case "annotate":
      return runAnnotateCli(rest);
    case "watch":
      return runWatchCli(rest);
    case "mcp":
      return runMcp();
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

async function runMcp(): Promise<number> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname: pathDirname, join: pathJoin } = await import("node:path");
  const here = pathDirname(fileURLToPath(import.meta.url));
  const entry = pathJoin(here, "mcp", "server.ts");
  return await new Promise<number>((resolve) => {
    const child = spawn("bun", ["run", entry], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
