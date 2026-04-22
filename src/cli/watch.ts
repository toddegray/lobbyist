/**
 * `lobbyist watch` — scheduled watchlist processor.
 *
 * Reads the watchlist from the DB, re-runs entity-profile for each entry,
 * diffs against the previously stored brief, and writes a digest of the
 * changes to ~/.lobbyist/digests/YYYY-MM-DD.md.
 *
 * Single-pass (`--once`) mode is the default. A loop with --interval-minutes
 * is available for long-running unattended execution.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveConfig } from "../core/config.ts";
import { LdaClient } from "../core/lda-client.ts";
import { openDb } from "../db/engine.ts";
import {
  addToWatchlist,
  listWatchlist,
  loadLatestBrief,
  removeFromWatchlist,
  saveBrief,
  upsertEntity,
} from "../db/repos.ts";
import { runEntityProfile, type EntityProfileData } from "../skills/entity-profile.ts";
import { getFlag, getIntFlag } from "./_shared.ts";
import type { Brief } from "../core/types.ts";

export async function runWatchCli(args: string[]): Promise<number> {
  // Subcommand-ish: --add=<entity_id>, --remove=<entity_id>, --list, default = run pass.
  const add = getFlag(args, "add");
  const remove = getFlag(args, "remove");
  const list = args.includes("--list");
  const once = args.includes("--once") || (!add && !remove && !list); // default to once
  const intervalMin = getIntFlag(args, "interval-minutes");

  const cfg = await resolveConfig();
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    if (list) {
      const items = await listWatchlist(db);
      if (items.length === 0) {
        process.stdout.write("watchlist is empty. Add with --add=<entity_id>.\n");
        return 0;
      }
      for (const it of items) {
        process.stdout.write(`- ${it.entity_id}  window=${it.window_key}  added=${it.added_at}\n`);
      }
      return 0;
    }

    if (add) {
      const winKey = getFlag(args, "window") ?? `${cfg.default_year_start}-${cfg.default_year_end}-all`;
      await addToWatchlist(db, add, winKey);
      process.stdout.write(`added ${add} (window=${winKey})\n`);
      return 0;
    }
    if (remove) {
      await removeFromWatchlist(db, remove);
      process.stdout.write(`removed ${remove}\n`);
      return 0;
    }

    // Process pass
    const lda = new LdaClient({
      apiKey: cfg.resolved_lda_key,
      cacheDir: cfg.cache_dir,
      rateLimitRps: cfg.lda_rate_limit_rps,
    });

    const runPass = async (): Promise<void> => {
      const items = await listWatchlist(db);
      if (items.length === 0) {
        process.stdout.write("watchlist is empty.\n");
        return;
      }
      const digestLines: string[] = [];
      digestLines.push(`# Watchlist digest — ${new Date().toISOString().slice(0, 10)}`);
      digestLines.push("");

      for (const it of items) {
        // Only process client entities — other kinds aren't re-runnable with entity-profile.
        if (!it.entity_id.startsWith("client:")) {
          digestLines.push(`- skipping ${it.entity_id} (not a client entity)`);
          continue;
        }
        const client_id = Number.parseInt(it.entity_id.slice("client:".length), 10);
        if (!Number.isFinite(client_id)) continue;

        const prev = await loadLatestBrief<EntityProfileData>(db, {
          entity_id: it.entity_id,
          skill: "entity-profile",
        });

        try {
          const next = await runEntityProfile(lda, db, {
            client_id,
            year_start: cfg.default_year_start,
            year_end: cfg.default_year_end,
          });
          await upsertEntity(db, {
            kind: next.entity.kind,
            id: next.entity.id,
            display: next.entity.display,
            external_id: next.entity.id,
          });
          await saveBrief(db, next);

          const changes = summarizeChange(prev, next);
          digestLines.push(`## ${next.entity.display}`);
          digestLines.push("");
          digestLines.push(changes);
          digestLines.push("");
        } catch (e) {
          digestLines.push(`## ${it.entity_id}`);
          digestLines.push("");
          digestLines.push(`error: ${e instanceof Error ? e.message : String(e)}`);
          digestLines.push("");
        }
      }

      const digestsDir = join(homedir(), ".lobbyist", "digests");
      await mkdir(digestsDir, { recursive: true });
      const path = join(digestsDir, `${new Date().toISOString().slice(0, 10)}.md`);
      await writeFile(path, digestLines.join("\n"));
      process.stdout.write(`wrote digest → ${path}\n`);
    };

    if (once) {
      await runPass();
      return 0;
    }

    // Loop mode
    const minutes = intervalMin ?? 60;
    process.stdout.write(`entering loop; interval=${minutes}m. Ctrl-C to exit.\n`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await runPass();
      await new Promise((r) => setTimeout(r, minutes * 60 * 1000));
    }
  } finally {
    await db.close();
  }
}

function summarizeChange(
  prev: Brief<EntityProfileData> | null,
  next: Brief<EntityProfileData>,
): string {
  if (!prev) {
    return `First observation. Total spend ${fmtUsd(next.data.totals.total_spend)}, ${next.data.totals.filings} filings.`;
  }
  const spendDelta = next.data.totals.total_spend - prev.data.totals.total_spend;
  const filingsDelta = next.data.totals.filings - prev.data.totals.filings;
  const lines: string[] = [];
  lines.push(
    `- Total spend: ${fmtUsd(prev.data.totals.total_spend)} → ${fmtUsd(next.data.totals.total_spend)} (Δ ${fmtUsd(spendDelta)})`,
  );
  lines.push(`- Filings: ${prev.data.totals.filings} → ${next.data.totals.filings} (Δ ${filingsDelta})`);
  // Issue-code changes
  const prevCodes = new Set(prev.data.top_issue_codes.map((i) => i.code));
  const nextCodes = new Set(next.data.top_issue_codes.map((i) => i.code));
  const added = [...nextCodes].filter((c) => !prevCodes.has(c));
  const dropped = [...prevCodes].filter((c) => !nextCodes.has(c));
  if (added.length) lines.push(`- Issue codes added: ${added.join(", ")}`);
  if (dropped.length) lines.push(`- Issue codes dropped: ${dropped.join(", ")}`);
  return lines.join("\n");
}

function fmtUsd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
