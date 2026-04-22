#!/usr/bin/env bun
/**
 * lobbyist CLI entry.
 *
 * Each skill gets its own top-level command. The orchestrator (`ask`) that
 * dispatches across skills from natural language comes in v0.5.
 */

import { runInit } from "./cli/init.ts";
import { runShowConfig } from "./cli/show-config.ts";
import { runPing } from "./cli/ping.ts";
import { runEntityProfileCli } from "./cli/entity-profile.ts";
import { runBillWatchersCli } from "./cli/bill-watchers.ts";
import { runSpendAnalysisCli } from "./cli/spend-analysis.ts";

const USAGE = `lobbyist — AI senior lobbying analyst

usage: lobbyist <command> [args]

setup:
  init                                    Interactive first-run setup (writes ~/.lobbyist/config.json)
  init --non-interactive --name=... --email=... --lda-key=...
                                          Non-interactive init for CI/headless use
  config [--reveal]                       Show the current resolved configuration
  ping                                    Sanity-check the configured LDA key

skills:
  entity-profile "<client name>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--quarter=1..4] [--format=md|json] [--write=path]
                                          Full lobbying profile for a company, trade association, or law firm:
                                          registrations, quarterly activity, lobbyists employed, issues lobbied,
                                          committees contacted, spend trend. Persists to entity memory.

  bill-watchers --bill="<substring>" OR --issue-code=HCR [--year-start=Y] [--year-end=Y] [--quarter=1..4] [--format=md|json] [--write=path]
                                          Given a bill cite or LDA general issue code, the list of every registered
                                          client lobbying on it, their firms, and their reported spend.

  spend-analysis "<client name>" [--client-id=N] [--year-start=Y] [--year-end=Y] [--format=md|json] [--write=path]
                                          Quarter-over-quarter spend trend with anomaly flags. Flags are
                                          suggestions, not accusations.

mcp:
  mcp                                     Start the lobbyist MCP stdio server (wires every skill into
                                          Claude Code / Desktop / Cursor).

env (overrides the config file when set):
  LOBBYIST_LDA_API_KEY      Senate LDA API token
  LOBBYIST_OPENFEC_API_KEY  OpenFEC / api.data.gov key (v0.5+)
  LOBBYIST_CONFIG_PATH      override path to config.json
  LOBBYIST_CACHE_DIR        override response cache dir
  LOBBYIST_DATA_DIR         override SQLite data dir
  ANTHROPIC_API_KEY         Anthropic key for narrative synthesis

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
