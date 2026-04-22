/**
 * ask — natural-language orchestrator.
 *
 * Takes a free-text question, lets Claude pick which lobbyist skills to run,
 * executes them, and synthesizes a narrative answer over the structured
 * results.
 *
 * Architecture:
 *   - Claude Messages API with tool use.
 *   - Tool surface mirrors the MCP surface (one tool per skill).
 *   - The orchestrator runs each tool, feeds the result back, and loops
 *     until Claude stops calling tools or we hit max_iterations.
 *   - Final assistant message is the synthesized brief.
 *
 * Narrative synthesis is an LLM product. Numbers, citations, and skill
 * outputs are structured; the narrative is the LLM's composition. This
 * matches integrator's pattern.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LdaClient } from "../core/lda-client.ts";
import type { OpenFecClient } from "../core/openfec-client.ts";
import type { UsaSpendingClient } from "../core/usaspending-client.ts";
import type { DbClient } from "../db/engine.ts";
import type { ResolvedConfig } from "../core/config.ts";
import { saveBrief, upsertEntity } from "../db/repos.ts";

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

// ---------------------------------------------------------------------------

export interface AskContext {
  cfg: ResolvedConfig;
  lda: LdaClient;
  openfec: OpenFecClient | null;
  usaspending: UsaSpendingClient | null;
  db: DbClient;
}

export interface AskOptions {
  question: string;
  maxIterations?: number;
  verbose?: boolean;
}

export interface AskResult {
  answer: string;
  iterations: number;
  tool_calls: Array<{ name: string; input: unknown }>;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string | null;
}

// ---------------------------------------------------------------------------

const SYSTEM = `You are a senior lobbying analyst. You answer questions about
US federal lobbying by calling deterministic tools that query Senate LDA
filings, FEC campaign contributions, and USASpending.gov contract awards.
You then compose a narrative answer over the structured results.

Rules (non-negotiable):
- Every number you cite must come from a tool's output. Never invent figures.
- Label derived analysis (ratios, coalition detection) as derived.
- Do not infer intent, motive, or quid-pro-quo. The tools report what was
  filed; you report the overlap.
- Anomaly flags are suggestions, not accusations.
- You cannot detect unregistered lobbying; the tools only see disclosed
  activity.
- If a question needs data you don't have, say so rather than guessing.

Start by considering which tools will answer the question, call them, then
synthesize. If a client name is ambiguous, entity-profile will surface it
and you can narrow.`;

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "entity_profile",
    description:
      "Full lobbying profile for a company / trade association / law firm: spend, lobbyists, issues, committees contacted.",
    input_schema: {
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
    name: "bill_watchers",
    description:
      "Who's lobbying on a given bill or issue code? Provide either `bill` (free-text) or `issue_code` (LDA code like HCR).",
    input_schema: {
      type: "object",
      properties: {
        bill: { type: "string" },
        issue_code: { type: "string" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
      },
    },
  },
  {
    name: "spend_analysis",
    description:
      "Quarter-over-quarter lobbying spend trend for a client, with YoY deltas and anomaly flags.",
    input_schema: {
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
    description:
      "Career arc for an individual registered lobbyist: covered positions, clients, firms, issues.",
    input_schema: {
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
    description:
      "LDA+FEC join. Given a member of Congress and issue codes of jurisdiction, ranks top lobbying clients with parallel FEC campaign contributions. Requires OpenFEC key.",
    input_schema: {
      type: "object",
      properties: {
        member: { type: "string" },
        candidate_id: { type: "string" },
        issue_codes: { type: "array", items: { type: "string" } },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
        cycle: { type: "integer" },
      },
      required: ["issue_codes"],
    },
  },
  {
    name: "contract_trace",
    description:
      "LDA+USASpending join. Given a client, compares lobbying spend with federal contract awards in the same period.",
    input_schema: {
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
    name: "coalition_detect",
    description:
      "Find entities lobbying together via shared registrant / shared issue / shared quarters. Mode: by issue (provide issue_code or bill) or by client (provide client/client_id).",
    input_schema: {
      type: "object",
      properties: {
        issue_code: { type: "string" },
        bill: { type: "string" },
        client: { type: "string" },
        client_id: { type: "integer" },
        year_start: { type: "integer" },
        year_end: { type: "integer" },
      },
    },
  },
  {
    name: "filing_diff",
    description:
      "Diff a client's filings between two windows (years or single quarters). Shows added/dropped lobbyists/issues/firms/govt entities + spend delta.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string" },
        client_id: { type: "integer" },
        from: { type: "string", description: "YYYY | YYYY-Qn | YYYY-YYYY" },
        to: { type: "string", description: "YYYY | YYYY-Qn | YYYY-YYYY" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "anomaly_scan",
    description:
      "Pattern scan on a client's filings: late filings, new lobbyists, ex-staffer hires (covered positions), issue churn, new govt entities contacted.",
    input_schema: {
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
    description:
      "Compose a full brief for a client from entity_profile + spend_analysis + anomaly_scan (and contract_trace if include_contract_trace=true).",
    input_schema: {
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
];

// ---------------------------------------------------------------------------

export async function runAsk(ctx: AskContext, opts: AskOptions): Promise<AskResult> {
  if (!ctx.cfg.resolved_anthropic_key) {
    throw new Error(
      "ask requires an Anthropic API key. Set ANTHROPIC_API_KEY or run `lobbyist init` and supply one.",
    );
  }
  const anthropic = new Anthropic({ apiKey: ctx.cfg.resolved_anthropic_key });
  const maxIterations = opts.maxIterations ?? 8;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: opts.question },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let iterations = 0;
  const toolCalls: AskResult["tool_calls"] = [];
  let stopReason: string | null = null;
  let finalAnswer = "";

  while (iterations < maxIterations) {
    iterations += 1;
    const res = await anthropic.messages.create({
      model: ctx.cfg.anthropic_model,
      max_tokens: 4096,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;
    stopReason = res.stop_reason;

    const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
    const textChunks: string[] = [];
    for (const block of res.content) {
      if (block.type === "text") textChunks.push(block.text);
      else if (block.type === "tool_use") toolUses.push(block);
    }
    if (textChunks.length) finalAnswer = textChunks.join("\n");

    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Execute tools
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls.push({ name: tu.name, input: tu.input });
      if (opts.verbose) {
        process.stderr.write(`[ask] tool ${tu.name} ${JSON.stringify(tu.input)}\n`);
      }
      try {
        const out = await runTool(ctx, tu.name, tu.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [{ type: "text", text: out }],
        });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    answer: finalAnswer,
    iterations,
    tool_calls: toolCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    stop_reason: stopReason,
  };
}

// ---------------------------------------------------------------------------

async function runTool(
  ctx: AskContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const ys = (args.year_start as number) ?? ctx.cfg.default_year_start;
  const ye = (args.year_end as number) ?? ctx.cfg.default_year_end;

  switch (name) {
    case "entity_profile": {
      const b = await runEntityProfile(ctx.lda, ctx.db, {
        client: args.client as string | undefined,
        client_id: args.client_id as number | undefined,
        year_start: ys,
        year_end: ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "bill_watchers": {
      const b = await runBillWatchers(ctx.lda, ctx.db, {
        bill: args.bill as string | undefined,
        issue_code: args.issue_code as string | undefined,
        year_start: ys,
        year_end: ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "spend_analysis": {
      const b = await runSpendAnalysis(ctx.lda, ctx.db, {
        client: args.client as string | undefined,
        client_id: args.client_id as number | undefined,
        year_start: ys,
        year_end: ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "revolving_door": {
      const b = await runRevolvingDoor(ctx.lda, ctx.db, {
        person: args.person as string | undefined,
        lobbyist_id: args.lobbyist_id as number | undefined,
        year_start: ys,
        year_end: ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "committee_influence": {
      if (!ctx.openfec) throw new Error("committee_influence requires an OpenFEC key");
      const b = await runCommitteeInfluence(ctx.lda, ctx.openfec, ctx.db, {
        member: args.member as string | undefined,
        candidate_id: args.candidate_id as string | undefined,
        issue_codes: (args.issue_codes as string[]) ?? [],
        year_start: ys,
        year_end: ye,
        cycle: (args.cycle as number) ?? ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "contract_trace": {
      if (!ctx.usaspending) throw new Error("contract_trace requires USASpending client");
      const b = await runContractTrace(ctx.lda, ctx.usaspending, ctx.db, {
        client: args.client as string | undefined,
        client_id: args.client_id as number | undefined,
        year_start: ys,
        year_end: ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "coalition_detect": {
      const b = await runCoalitionDetect(ctx.lda, ctx.db, {
        issue_code: args.issue_code as string | undefined,
        bill: args.bill as string | undefined,
        client: args.client as string | undefined,
        client_id: args.client_id as number | undefined,
        year_start: ys,
        year_end: ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "filing_diff": {
      const { parseWindow } = await import("./ask-helpers.ts");
      const b = await runFilingDiff(ctx.lda, ctx.db, {
        client: args.client as string | undefined,
        client_id: args.client_id as number | undefined,
        from_window: parseWindow(args.from as string, "from"),
        to_window: parseWindow(args.to as string, "to"),
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "anomaly_scan": {
      const b = await runAnomalyScan(ctx.lda, ctx.db, {
        client: args.client as string | undefined,
        client_id: args.client_id as number | undefined,
        year_start: ys,
        year_end: ye,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
    case "compose_brief": {
      const b = await runComposeBrief(ctx.lda, ctx.db, ctx.usaspending, {
        client: args.client as string | undefined,
        client_id: args.client_id as number | undefined,
        year_start: ys,
        year_end: ye,
        include_contract_trace: args.include_contract_trace === true,
      });
      await persist(ctx, b);
      return toolOut(b);
    }
  }
  throw new Error(`unknown tool: ${name}`);
}

async function persist<T>(ctx: AskContext, brief: { entity: { kind: any; id: string; display: string } } & any): Promise<void> {
  try {
    await upsertEntity(ctx.db, {
      kind: brief.entity.kind,
      id: brief.entity.id,
      display: brief.entity.display,
      external_id: brief.entity.id,
    });
    await saveBrief(ctx.db, brief);
  } catch {
    // best-effort
  }
}

function toolOut(b: { markdown: string; data: unknown; citations: unknown[] }): string {
  // Include markdown + just enough JSON to let the model reason about
  // specific fields without burning tokens on everything.
  const preview = {
    data: b.data,
    citations: b.citations,
  };
  return `${b.markdown}\n\n<structured_json>\n${JSON.stringify(preview, null, 2).slice(0, 20000)}\n</structured_json>`;
}
