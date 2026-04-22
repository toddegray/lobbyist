/**
 * `lobbyist recall [<entity>] [--kind=...] [--skill=...] [--brief]` — memory query.
 *
 * Shows stored briefs + annotations for entities in local memory.
 *   - No args → list 50 most recently-seen entities.
 *   - With <entity> query → match by display name (LIKE), external_id, or raw entity_id.
 *   - --brief → print the latest brief's markdown.
 */

import { resolveConfig } from "../core/config.ts";
import { openDb } from "../db/engine.ts";
import {
  entityKey,
  getEntity,
  listAnnotations,
  listBriefsForEntity,
  loadLatestBrief,
} from "../db/repos.ts";
import { getFirstPositional, getFlag } from "./_shared.ts";
import type { EntityKind } from "../core/types.ts";

export async function runRecallCli(args: string[]): Promise<number> {
  const query = getFirstPositional(args);
  const kind = getFlag(args, "kind") as EntityKind | undefined;
  const skill = getFlag(args, "skill");
  const format = (getFlag(args, "format") ?? "md") as "md" | "json";
  const printBrief = args.includes("--brief");

  const cfg = await resolveConfig();
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    let entityIds: string[];
    if (query) {
      const like = `%${query.toLowerCase()}%`;
      const rows = kind
        ? await db.query<{ entity_id: string }>(
            `SELECT entity_id FROM entities WHERE kind = ? AND (lower(display) LIKE ? OR external_id = ? OR entity_id = ?) ORDER BY last_seen DESC LIMIT 50`,
            [kind, like, query, query],
          )
        : await db.query<{ entity_id: string }>(
            `SELECT entity_id FROM entities WHERE lower(display) LIKE ? OR external_id = ? OR entity_id = ? ORDER BY last_seen DESC LIMIT 50`,
            [like, query, query],
          );
      entityIds = rows.map((r) => r.entity_id);
    } else {
      const rows = await db.query<{ entity_id: string }>(
        `SELECT entity_id FROM entities ORDER BY last_seen DESC LIMIT 50`,
      );
      entityIds = rows.map((r) => r.entity_id);
    }

    if (entityIds.length === 0) {
      process.stdout.write("no matching entities in memory\n");
      return 0;
    }

    if (printBrief) {
      const id = entityIds[0]!;
      const s = skill ?? "entity-profile";
      const brief = await loadLatestBrief<unknown>(db, { entity_id: id, skill: s });
      if (!brief) {
        process.stderr.write(`no ${s} brief stored for ${id}\n`);
        return 1;
      }
      process.stdout.write(
        (format === "json" ? JSON.stringify(brief, null, 2) : brief.markdown) + "\n",
      );
      return 0;
    }

    const lines: string[] = [];
    for (const id of entityIds) {
      const ent = await getEntity(db, id);
      if (!ent) continue;
      const briefs = await listBriefsForEntity(db, id);
      const notes = await listAnnotations(db, id);
      const header = `${ent.display}  [${ent.kind}]${ent.external_id ? `  (${ent.external_id})` : ""}  — ${entityKey(ent.kind, ent.id)}`;
      lines.push(header);
      if (briefs.length === 0) lines.push("  (no stored briefs)");
      for (const b of briefs) lines.push(`  • ${b.skill} ${b.window_key}  ${b.generated_at}`);
      for (const n of notes) lines.push(`  note (${n.created_at}): ${n.note}`);
      lines.push("");
    }
    process.stdout.write(lines.join("\n"));
    return 0;
  } finally {
    await db.close();
  }
}
