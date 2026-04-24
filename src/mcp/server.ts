#!/usr/bin/env bun
/**
 * lobbyist MCP server.
 *
 * Exposes all 10 skills plus memory ops as stdio MCP tools.
 *
 * Transport: stdio. Each tool returns markdown + structured JSON.
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
import { OpenFecClient } from "../core/openfec-client.ts";
import { UsaSpendingClient } from "../core/usaspending-client.ts";
import { CongressClient } from "../core/congress-client.ts";
import { openDb, type DbClient } from "../db/engine.ts";
import {
  addAnnotation,
  entityKey,
  getEntity,
  listAnnotations,
  listBriefsForEntity,
  loadLatestBrief,
  saveBrief,
  upsertEntity,
} from "../db/repos.ts";
import type { Brief, EntityKind } from "../core/types.ts";
import { parseWindow } from "../agents/ask-helpers.ts";

import { runEntityProfile } from "../skills/entity-profile.ts";
import { runBillWatchers } from "../skills/bill-watchers.ts";
import { runSpendAnalysis } from "../skills/spend-analysis.ts";
import { runRevolvingDoor } from "../skills/revolving-door.ts";
import { runCommitteeInfluence } from "../skills/committee-influence.ts";
import { runContractTrace } from "../skills/contract-trace.ts";
import { runCoalitionDetect } from "../skills/coalition-detect.ts";
import { runFilingDiff } from "../skills/filing-diff.ts";
import { runAnomalyScan } from "../skills/anomaly-scan.ts";
import { runComposeBrief } from "../skills/brief.ts";

// Lazy singletons
let cachedCfg: ResolvedConfig | null = null;
let cachedLda: LdaClient | null = null;
let cachedFec: OpenFecClient | null = null;
let cachedUsa: UsaSpendingClient | null = null;
let cachedCongress: CongressClient | null = null;
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
async function ensureFec(): Promise<OpenFecClient> {
  if (!cachedFec) {
    const cfg = await ensureCfg();
    if (!cfg.resolved_openfec_key) {
      throw new Error("This tool requires an OpenFEC API key. Configure via `lobbyist init`.");
    }
    cachedFec = new OpenFecClient({
      apiKey: cfg.resolved_openfec_key,
      cacheDir: cfg.cache_dir,
      rateLimitRps: cfg.openfec_rate_limit_rps,
    });
  }
  return cachedFec;
}
async function ensureUsa(): Promise<UsaSpendingClient> {
  if (!cachedUsa) {
    const cfg = await ensureCfg();
    cachedUsa = new UsaSpendingClient({
      apiKey: cfg.usaspending_api_key,
      cacheDir: cfg.cache_dir,
      rateLimitRps: 2,
    });
  }
  return cachedUsa;
}
/**
 * Congress.gov client is optional — returned null if no api.data.gov key is
 * configured. Callers should handle null (the bill_watchers tool degrades
 * gracefully; congress_bill just won't be enriched).
 */
async function ensureCongress(): Promise<CongressClient | null> {
  if (!cachedCongress) {
    const cfg = await ensureCfg();
    if (!cfg.resolved_congress_key) return null;
    cachedCongress = new CongressClient({
      apiKey: cfg.resolved_congress_key,
      cacheDir: cfg.cache_dir,
      rateLimitRps: 1,
    });
  }
  return cachedCongress;
}
async function ensureDb(): Promise<DbClient> {
  if (!cachedDb) {
    const cfg = await ensureCfg();
    cachedDb = await openDb({ dataDir: cfg.data_dir });
  }
  return cachedDb;
}

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
  } catch {}
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
    description: "Full lobbying profile for a company / trade association / law firm: registrations, quarterly activity, lobbyists employed, issues, committees contacted, spend trend.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        client_id: { type: "integer" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        quarter: { type: "integer", enum: [1, 2, 3, 4] },
      },
    },
  },
  {
    name: "bill_watchers",
    description:
      "Clients lobbying on a given bill (free-text substring, LDA general issue code, or Congress.gov exact bill reference). When congress_bill is supplied, the output is enriched with official title, sponsor, committees of jurisdiction.",
    inputSchema: {
      type: "object",
      properties: {
        bill: { type: "string", description: "Free-text substring matched against LDA filings' specific-issue field." },
        issue_code: { type: "string", description: "LDA general issue code (e.g. HCR, TAX)." },
        congress_bill: {
          type: "object",
          description: "Exact Congress.gov bill reference. Enriches output with bill metadata.",
          properties: {
            congress: { type: "integer" },
            type: { type: "string", description: "HR | S | HJRES | SJRES | HCONRES | SCONRES | HRES | SRES" },
            number: { type: "string" },
          },
          required: ["congress", "type", "number"],
        },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        quarter: { type: "integer", enum: [1, 2, 3, 4] },
      },
    },
  },
  {
    name: "spend_analysis",
    description: "Quarter-over-quarter lobbying spend trend with YoY deltas and anomaly flags.",
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
    name: "revolving_door",
    description: "Career arc for an individual lobbyist: covered positions, clients, firms, issues.",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string" },
        lobbyist_id: { type: "integer" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
      },
    },
  },
  {
    name: "committee_influence",
    description: "LDA+FEC join: lobbying clients on issues of jurisdiction × FEC contributions to member's principal campaign committee. Requires OpenFEC key.",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string" },
        candidate_id: { type: "string" },
        issue_codes: { type: "array", items: { type: "string" } },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        cycle: { type: "integer" },
        top_n_clients: { type: "integer" },
      },
      required: ["issue_codes"],
    },
  },
  {
    name: "contract_trace",
    description: "LDA+USASpending join: client's lobbying spend vs federal contract awards in the same period.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        client_id: { type: "integer" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        usaspending_recipient: { type: "string" },
      },
    },
  },
  {
    name: "coalition_detect",
    description: "Groups of clients lobbying together via a shared firm. By-issue or by-client mode.",
    inputSchema: {
      type: "object",
      properties: {
        issue_code: { type: "string" },
        bill: { type: "string" },
        client: { type: "string" },
        client_id: { type: "integer" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        min_coalition_size: { type: "integer" },
      },
    },
  },
  {
    name: "filing_diff",
    description: "Diff a client's filings between two windows (YYYY, YYYY-Qn, or YYYY-YYYY).",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        client_id: { type: "integer" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "anomaly_scan",
    description: "Pattern scan: late filings, new lobbyists, ex-staffer hires, issue churn, new govt entities.",
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
    name: "compose_brief",
    description: "Full brief: entity_profile + spend_analysis + anomaly_scan (+ optional contract_trace).",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        client_id: { type: "integer" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        include_contract_trace: { type: "boolean" },
      },
    },
  },
  {
    name: "recall_entity",
    description: "Recall stored briefs + annotations from local memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        skill: { type: "string" },
        print_brief: { type: "boolean" },
      },
    },
  },
  {
    name: "annotate_entity",
    description: "Attach a free-text note to an entity in memory. Carried into future recall.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        note: { type: "string" },
        kind: { type: "string" },
      },
      required: ["query", "note"],
    },
  },
  {
    name: "resolve_config",
    description: "Return the resolved lobbyist config with API keys masked.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------

async function dispatch(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const cfg = await ensureCfg();
    const ys = (args.year_start as number) ?? cfg.default_year_start;
    const ye = (args.year_end as number) ?? cfg.default_year_end;

    switch (name) {
      case "entity_profile": {
        const brief = await runEntityProfile(await ensureLda(), await ensureDb(), {
          client: args.client as string | undefined,
          client_id: args.client_id as number | undefined,
          year_start: ys,
          year_end: ye,
          quarter: args.quarter as 1 | 2 | 3 | 4 | undefined,
        });
        return shipBrief(brief);
      }
      case "bill_watchers": {
        const cb = args.congress_bill as
          | { congress: number; type: string; number: string | number }
          | undefined;
        const brief = await runBillWatchers(
          await ensureLda(),
          await ensureDb(),
          {
            bill: args.bill as string | undefined,
            issue_code: args.issue_code as string | undefined,
            congress_bill: cb
              ? { congress: cb.congress, type: cb.type, number: String(cb.number) }
              : undefined,
            year_start: ys,
            year_end: ye,
            quarter: args.quarter as 1 | 2 | 3 | 4 | undefined,
          },
          await ensureCongress(),
        );
        return shipBrief(brief);
      }
      case "spend_analysis": {
        const brief = await runSpendAnalysis(await ensureLda(), await ensureDb(), {
          client: args.client as string | undefined,
          client_id: args.client_id as number | undefined,
          year_start: ys,
          year_end: ye,
        });
        return shipBrief(brief);
      }
      case "revolving_door": {
        const brief = await runRevolvingDoor(await ensureLda(), await ensureDb(), {
          person: args.person as string | undefined,
          lobbyist_id: args.lobbyist_id as number | undefined,
          year_start: ys,
          year_end: ye,
        });
        return shipBrief(brief);
      }
      case "committee_influence": {
        const brief = await runCommitteeInfluence(
          await ensureLda(),
          await ensureFec(),
          await ensureDb(),
          {
            member: args.member as string | undefined,
            candidate_id: args.candidate_id as string | undefined,
            issue_codes: (args.issue_codes as string[]) ?? [],
            year_start: ys,
            year_end: ye,
            cycle: (args.cycle as number) ?? ye,
            top_n_clients: args.top_n_clients as number | undefined,
          },
        );
        return shipBrief(brief);
      }
      case "contract_trace": {
        const brief = await runContractTrace(
          await ensureLda(),
          await ensureUsa(),
          await ensureDb(),
          {
            client: args.client as string | undefined,
            client_id: args.client_id as number | undefined,
            year_start: ys,
            year_end: ye,
            usaspending_recipient: args.usaspending_recipient as string | undefined,
          },
        );
        return shipBrief(brief);
      }
      case "coalition_detect": {
        const brief = await runCoalitionDetect(await ensureLda(), await ensureDb(), {
          issue_code: args.issue_code as string | undefined,
          bill: args.bill as string | undefined,
          client: args.client as string | undefined,
          client_id: args.client_id as number | undefined,
          year_start: ys,
          year_end: ye,
          min_coalition_size: args.min_coalition_size as number | undefined,
        });
        return shipBrief(brief);
      }
      case "filing_diff": {
        const brief = await runFilingDiff(await ensureLda(), await ensureDb(), {
          client: args.client as string | undefined,
          client_id: args.client_id as number | undefined,
          from_window: parseWindow(String(args.from), "from"),
          to_window: parseWindow(String(args.to), "to"),
        });
        return shipBrief(brief);
      }
      case "anomaly_scan": {
        const brief = await runAnomalyScan(await ensureLda(), await ensureDb(), {
          client: args.client as string | undefined,
          client_id: args.client_id as number | undefined,
          year_start: ys,
          year_end: ye,
        });
        return shipBrief(brief);
      }
      case "compose_brief": {
        const usa = args.include_contract_trace === true ? await ensureUsa() : null;
        const brief = await runComposeBrief(await ensureLda(), await ensureDb(), usa, {
          client: args.client as string | undefined,
          client_id: args.client_id as number | undefined,
          year_start: ys,
          year_end: ye,
          include_contract_trace: args.include_contract_trace === true,
        });
        return shipBrief(brief);
      }
      case "recall_entity": {
        const db = await ensureDb();
        const q = args.query as string | undefined;
        const kind = args.kind as EntityKind | undefined;
        const skill = args.skill as string | undefined;
        const printBrief = args.print_brief === true;
        let entityIds: string[] = [];
        if (q) {
          const like = `%${q.toLowerCase()}%`;
          const rows = kind
            ? await db.query<{ entity_id: string }>(
                `SELECT entity_id FROM entities WHERE kind = ? AND (lower(display) LIKE ? OR external_id = ? OR entity_id = ?) ORDER BY last_seen DESC`,
                [kind, like, q, q],
              )
            : await db.query<{ entity_id: string }>(
                `SELECT entity_id FROM entities WHERE lower(display) LIKE ? OR external_id = ? OR entity_id = ? ORDER BY last_seen DESC`,
                [like, q, q],
              );
          entityIds = rows.map((r) => r.entity_id);
        } else {
          const rows = await db.query<{ entity_id: string }>(
            `SELECT entity_id FROM entities ORDER BY last_seen DESC LIMIT 50`,
          );
          entityIds = rows.map((r) => r.entity_id);
        }
        if (entityIds.length === 0) {
          return { content: [{ type: "text", text: "no matching entities in memory" }] };
        }
        if (printBrief) {
          const id = entityIds[0]!;
          const s = skill ?? "entity-profile";
          const b = await loadLatestBrief<unknown>(db, { entity_id: id, skill: s });
          if (!b) return errorResult(`no ${s} brief stored for ${id}`);
          return { content: [{ type: "text", text: b.markdown }] };
        }
        const chunks: string[] = [];
        for (const id of entityIds) {
          const ent = await getEntity(db, id);
          if (!ent) continue;
          const briefs = await listBriefsForEntity(db, id);
          const notes = await listAnnotations(db, id);
          const header = `${ent.display}  [${ent.kind}]${ent.external_id ? `  (${ent.external_id})` : ""}  — ${entityKey(ent.kind, ent.id)}`;
          const body: string[] = [header];
          if (briefs.length === 0) body.push("  (no stored briefs)");
          for (const b of briefs) body.push(`  • ${b.skill} ${b.window_key}  ${b.generated_at}`);
          for (const n of notes) body.push(`  note (${n.created_at}): ${n.note}`);
          chunks.push(body.join("\n"));
        }
        return { content: [{ type: "text", text: chunks.join("\n\n") }] };
      }
      case "annotate_entity": {
        const db = await ensureDb();
        const q = String(args.query ?? "");
        const note = String(args.note ?? "");
        const kind = args.kind as EntityKind | undefined;
        if (!q || !note) return errorResult("query and note are both required");
        const like = `%${q.toLowerCase()}%`;
        const rows = kind
          ? await db.query<{ entity_id: string; display: string }>(
              `SELECT entity_id, display FROM entities WHERE kind = ? AND (lower(display) LIKE ? OR external_id = ? OR entity_id = ?) ORDER BY last_seen DESC LIMIT 5`,
              [kind, like, q, q],
            )
          : await db.query<{ entity_id: string; display: string }>(
              `SELECT entity_id, display FROM entities WHERE lower(display) LIKE ? OR external_id = ? OR entity_id = ? ORDER BY last_seen DESC LIMIT 5`,
              [like, q, q],
            );
        if (rows.length === 0) return errorResult(`no entities match "${q}"`);
        if (rows.length > 1)
          return errorResult(
            `multiple entities match "${q}": ` + rows.map((r) => `${r.entity_id} (${r.display})`).join(", "),
          );
        await addAnnotation(db, rows[0]!.entity_id, note);
        return { content: [{ type: "text", text: `annotated ${rows[0]!.display} (${rows[0]!.entity_id})` }] };
      }
      case "resolve_config": {
        const mask = (s: string | null) =>
          !s ? "(unset)" : s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-4)}`;
        return {
          content: [
            {
              type: "text",
              text:
                "```json\n" +
                JSON.stringify(
                  {
                    source_path: cfg.source_path,
                    operator: cfg.operator,
                    lda_api_key: mask(cfg.resolved_lda_key),
                    openfec_api_key: mask(cfg.resolved_openfec_key),
                    congress_api_key: mask(cfg.resolved_congress_key),
                    anthropic_api_key: mask(cfg.resolved_anthropic_key),
                    cache_dir: cfg.cache_dir,
                    data_dir: cfg.data_dir,
                    default_year_range: [cfg.default_year_start, cfg.default_year_end],
                    watchlist: cfg.watchlist,
                  },
                  null,
                  2,
                ) +
                "\n```",
            },
          ],
        };
      }
    }
    return errorResult(`unknown tool: ${name}`);
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: "lobbyist", version: "0.5.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return dispatch(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
