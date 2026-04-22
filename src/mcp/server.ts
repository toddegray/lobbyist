#!/usr/bin/env bun
/**
 * lobbyist MCP server.
 *
 * Wraps every v0.1 skill as an MCP tool so Claude Code, Claude Desktop,
 * Cursor, or any MCP-speaking client can drive lobbyist from natural language.
 *
 * Transport: stdio. Each tool returns the skill's rendered markdown as a
 * text content block, plus a second block with the structured JSON envelope.
 * Clients that only render the first block still get a readable brief.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveConfig, type ResolvedConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb, type DbClient } from "../db/engine.ts";
import { saveBrief, upsertEntity } from "../db/repos.ts";
import type { Brief } from "../core/types.ts";

import { runEntityProfile } from "../skills/entity-profile.ts";
import { runBillWatchers } from "../skills/bill-watchers.ts";
import { runSpendAnalysis } from "../skills/spend-analysis.ts";

// ---------------------------------------------------------------------------
// Lazy singletons. Opened on first tool call so `lobbyist mcp` startup stays
// fast when a client just wants the tool list.
// ---------------------------------------------------------------------------

let cachedCfg: ResolvedConfig | null = null;
let cachedLda: LdaClient | null = null;
let cachedDb: DbClient | null = null;

async function ensureCfg(): Promise<ResolvedConfig> {
  if (!cachedCfg) cachedCfg = await resolveConfig();
  return cachedCfg;
}

async function ensureLda(): Promise<LdaClient> {
  if (!cachedLda) {
    const cfg = await ensureCfg();
    cachedLda = new LdaClient({
      apiKey: cfg.resolved_lda_key,
      cacheDir: cfg.cache_dir,
      rateLimitRps: cfg.lda_rate_limit_rps,
    });
  }
  return cachedLda;
}

async function ensureDb(): Promise<DbClient> {
  if (!cachedDb) {
    const cfg = await ensureCfg();
    cachedDb = await openDb({ dataDir: cfg.data_dir });
  }
  return cachedDb;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function shipBrief<T>(brief: Brief<T>): Promise<CallToolResult> {
  try {
    const db = await ensureDb();
    await upsertEntity(db, {
      kind: brief.entity.kind,
      id: brief.entity.id,
      display: brief.entity.display,
      external_id: brief.entity.id,
    });
    await saveBrief(db, brief);
  } catch {
    // Best-effort: never fail the tool call over a local-DB hiccup.
  }
  return {
    content: [
      { type: "text", text: brief.markdown },
      {
        type: "text",
        text:
          "```json\n" +
          JSON.stringify(
            {
              skill: brief.skill,
              schema_version: brief.schema_version,
              entity: brief.entity,
              window: brief.window,
              generated_at: brief.generated_at,
              data: brief.data,
              citations: brief.citations,
            },
            null,
            2,
          ) +
          "\n```",
      },
    ],
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "entity_profile",
    description:
      "Full lobbying profile for a company, trade association, or law firm: registrations, quarterly activity, lobbyists employed, issues lobbied, committees contacted, spend trend. Persists to local entity memory.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client name, e.g. \"Pfizer Inc\". Ignored if client_id is set." },
        client_id: { type: "integer", description: "LDA client_id (skip name resolution)." },
        year_start: { type: "integer", description: "Inclusive start year. Defaults to configured default_year_start." },
        year_end: { type: "integer", description: "Inclusive end year. Defaults to configured default_year_end." },
        quarter: { type: "integer", enum: [1, 2, 3, 4], description: "Optional quarter filter across each year." },
      },
    },
  },
  {
    name: "bill_watchers",
    description:
      "Given a bill cite (free-text substring) or LDA general issue code, produces the ranked list of clients lobbying on it, the firms they hired, and their reported spend.",
    inputSchema: {
      type: "object",
      properties: {
        bill: { type: "string", description: "Free-text bill cite or topic, e.g. \"HR 5376\" or \"CHIPS Act\"." },
        issue_code: { type: "string", description: "LDA general issue code, e.g. \"HCR\" (Health), \"TAX\" (Taxation)." },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        quarter: { type: "integer", enum: [1, 2, 3, 4] },
      },
    },
  },
  {
    name: "spend_analysis",
    description:
      "Quarter-over-quarter spend series for a client, with annual totals, YoY change, and anomaly flags (quarterly spikes, YoY jumps, sudden zeros). Flags are suggestions, not accusations.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        client_id: { type: "integer" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
      },
    },
  },
  {
    name: "resolve_config",
    description: "Return the resolved lobbyist configuration (API keys masked).",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "entity_profile": {
        const lda = await ensureLda();
        const db = await ensureDb();
        const cfg = await ensureCfg();
        const brief = await runEntityProfile(lda, db, {
          client: (args.client as string) ?? undefined,
          client_id: (args.client_id as number) ?? undefined,
          year_start: (args.year_start as number) ?? cfg.default_year_start,
          year_end: (args.year_end as number) ?? cfg.default_year_end,
          quarter: (args.quarter as 1 | 2 | 3 | 4) ?? undefined,
        });
        return shipBrief(brief);
      }
      case "bill_watchers": {
        const lda = await ensureLda();
        const db = await ensureDb();
        const cfg = await ensureCfg();
        const brief = await runBillWatchers(lda, db, {
          bill: (args.bill as string) ?? undefined,
          issue_code: (args.issue_code as string) ?? undefined,
          year_start: (args.year_start as number) ?? cfg.default_year_start,
          year_end: (args.year_end as number) ?? cfg.default_year_end,
          quarter: (args.quarter as 1 | 2 | 3 | 4) ?? undefined,
        });
        return shipBrief(brief);
      }
      case "spend_analysis": {
        const lda = await ensureLda();
        const db = await ensureDb();
        const cfg = await ensureCfg();
        const brief = await runSpendAnalysis(lda, db, {
          client: (args.client as string) ?? undefined,
          client_id: (args.client_id as number) ?? undefined,
          year_start: (args.year_start as number) ?? cfg.default_year_start,
          year_end: (args.year_end as number) ?? cfg.default_year_end,
        });
        return shipBrief(brief);
      }
      case "resolve_config": {
        const cfg = await ensureCfg();
        const mask = (s: string | null) =>
          !s ? "(unset)" : s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-4)}`;
        const payload = {
          source_path: cfg.source_path,
          operator: cfg.operator,
          lda_api_key: mask(cfg.resolved_lda_key),
          openfec_api_key: mask(cfg.resolved_openfec_key),
          anthropic_api_key: mask(cfg.resolved_anthropic_key),
          cache_dir: cfg.cache_dir,
          data_dir: cfg.data_dir,
          lda_rate_limit_rps: cfg.lda_rate_limit_rps,
          default_year_start: cfg.default_year_start,
          default_year_end: cfg.default_year_end,
          watchlist: cfg.watchlist,
        };
        return {
          content: [
            { type: "text", text: "```json\n" + JSON.stringify(payload, null, 2) + "\n```" },
          ],
        };
      }
    }
    return errorResult(`unknown tool: ${name}`);
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = new Server(
    { name: "lobbyist", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return dispatch(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
