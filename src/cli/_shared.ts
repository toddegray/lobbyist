/**
 * Shared helpers for CLI command wrappers.
 *
 * Every skill CLI follows the same boilerplate:
 *   1. parse --key=value flags
 *   2. resolve config
 *   3. open clients (lda, optionally openfec/usaspending/congress)
 *   4. run the skill
 *   5. persist the brief
 *   6. emit md or json to stdout or --write=path
 *
 * Keep this file tiny — premature abstraction kills readability. The
 * helpers here only exist if the same code appears three times.
 */

import { writeFile } from "node:fs/promises";
import type { Brief } from "../core/types.ts";
import type { DbClient } from "../db/engine.ts";
import { saveBrief, upsertEntity } from "../db/repos.ts";

export function getFlag(args: string[], key: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(`--${key}=`.length) : undefined;
}

export function getIntFlag(args: string[], key: string): number | undefined {
  const raw = getFlag(args, key);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function getFirstPositional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

export async function emitBrief<T>(
  db: DbClient,
  brief: Brief<T>,
  opts: { format?: "md" | "json"; write?: string | undefined },
): Promise<void> {
  await upsertEntity(db, {
    kind: brief.entity.kind,
    id: brief.entity.id,
    display: brief.entity.display,
    external_id: brief.entity.id,
  });
  await saveBrief(db, brief);

  const fmt = opts.format ?? "md";
  const out = fmt === "json" ? JSON.stringify(brief, null, 2) + "\n" : brief.markdown + "\n";
  if (opts.write) {
    await writeFile(opts.write, out);
    process.stdout.write(`wrote ${opts.write}\n`);
  } else {
    process.stdout.write(out);
  }
}
