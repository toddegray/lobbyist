/**
 * `lobbyist annotate <entity> "<note>"` — append a free-text note to an entity.
 *
 * Notes are carried into future briefs by the brief composer and surfaced
 * by `recall`. Matching is LIKE against display, plus exact-match on
 * external_id and entity_id. If >1 entity matches, the command errors and
 * shows the candidates.
 */

import { resolveConfig } from "../core/config.ts";
import { openDb } from "../db/engine.ts";
import { addAnnotation } from "../db/repos.ts";
import { getFlag } from "./_shared.ts";
import type { EntityKind } from "../core/types.ts";

export async function runAnnotateCli(args: string[]): Promise<number> {
  // Positional: first non-flag is the query, second is the note.
  const positionals = args.filter((a) => !a.startsWith("--"));
  const query = positionals[0];
  const note = positionals.slice(1).join(" ");
  const kind = getFlag(args, "kind") as EntityKind | undefined;

  if (!query || !note) {
    console.error('usage: lobbyist annotate <entity> "<note>" [--kind=client|registrant|lobbyist|member]');
    return 2;
  }

  const cfg = await resolveConfig();
  const db = await openDb({ dataDir: cfg.data_dir });
  try {
    const like = `%${query.toLowerCase()}%`;
    const rows = kind
      ? await db.query<{ entity_id: string; display: string }>(
          `SELECT entity_id, display FROM entities WHERE kind = ? AND (lower(display) LIKE ? OR external_id = ? OR entity_id = ?) ORDER BY last_seen DESC LIMIT 5`,
          [kind, like, query, query],
        )
      : await db.query<{ entity_id: string; display: string }>(
          `SELECT entity_id, display FROM entities WHERE lower(display) LIKE ? OR external_id = ? OR entity_id = ? ORDER BY last_seen DESC LIMIT 5`,
          [like, query, query],
        );
    if (rows.length === 0) {
      process.stderr.write(`no entities match "${query}"\n`);
      return 1;
    }
    if (rows.length > 1) {
      process.stderr.write(
        `multiple entities match "${query}":\n` +
          rows.map((r) => `  ${r.entity_id}  ${r.display}`).join("\n") +
          "\nretry with --kind= to disambiguate.\n",
      );
      return 1;
    }
    await addAnnotation(db, rows[0]!.entity_id, note);
    process.stdout.write(`annotated ${rows[0]!.display} (${rows[0]!.entity_id})\n`);
    return 0;
  } finally {
    await db.close();
  }
}
