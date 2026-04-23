/**
 * Typed repository functions for lobbyist's SQLite store.
 *
 * All cross-skill data access goes through this module. Skills import the
 * helpers they need; they never touch SQL directly. This keeps schema
 * changes localized and makes it obvious where a skill reads / writes
 * entity memory.
 */

import type { DbClient } from "./engine.ts";
import type { Brief, EntityId, EntityKind } from "../core/types.ts";
import { windowKey } from "../core/types.ts";
import type { Filing } from "../core/lda-endpoints.ts";
import { filingSpend } from "../core/lda-endpoints.ts";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Name normalizer used by entity_aliases. Uppercase, strip punctuation,
 * collapse whitespace, strip common legal suffixes. This is the cheap
 * first-pass match; skills layer fuzzy matching on top when they need it.
 */
export function normalizeEntityName(raw: string): string {
  const upper = raw.toUpperCase();
  const stripped = upper
    .replace(/[.,;:'"()&/\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const suffixes = [
    " INC",
    " INCORPORATED",
    " CORP",
    " CORPORATION",
    " CO",
    " COMPANY",
    " LLC",
    " LLP",
    " LP",
    " LTD",
    " HOLDINGS",
    " GROUP",
    " THE",
  ];
  let out = stripped;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of suffixes) {
      if (out.endsWith(suf)) {
        out = out.slice(0, -suf.length).trim();
        changed = true;
      }
    }
  }
  return out || stripped;
}

interface EntityRow {
  entity_id: string;
  kind: string;
  external_id: string | null;
  display: string;
  metadata: string | null;
}

export interface StoredEntity extends EntityId {
  external_id: string | null;
  metadata: Record<string, unknown>;
}

function toStoredEntity(row: EntityRow): StoredEntity {
  return {
    kind: row.kind as EntityKind,
    id: row.entity_id.slice(row.kind.length + 1),
    display: row.display,
    external_id: row.external_id,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
  };
}

export async function upsertEntity(
  db: DbClient,
  input: {
    kind: EntityKind;
    id: string;
    display: string;
    external_id?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const entity_id = entityKey(input.kind, input.id);
  await db.run(
    `INSERT INTO entities (entity_id, kind, external_id, display, metadata)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       display     = excluded.display,
       external_id = excluded.external_id,
       metadata    = excluded.metadata,
       last_seen   = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [
      entity_id,
      input.kind,
      input.external_id ?? null,
      input.display,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return entity_id;
}

export async function getEntity(
  db: DbClient,
  entity_id: string,
): Promise<StoredEntity | null> {
  const rows = await db.query<EntityRow>(
    `SELECT entity_id, kind, external_id, display, metadata FROM entities WHERE entity_id = ?`,
    [entity_id],
  );
  return rows[0] ? toStoredEntity(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Entity aliases (the resolution graph)
// ---------------------------------------------------------------------------

export async function upsertEntityAlias(
  db: DbClient,
  input: {
    entity_id: string;
    raw: string;
    source: string;
    confirmed?: boolean;
  },
): Promise<void> {
  const normalized = normalizeEntityName(input.raw);
  await db.run(
    `INSERT INTO entity_aliases (entity_id, raw, normalized, source, confirmed)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, normalized, source) DO UPDATE SET
       confirmed = MAX(entity_aliases.confirmed, excluded.confirmed)`,
    [
      input.entity_id,
      input.raw,
      normalized,
      input.source,
      input.confirmed ? 1 : 0,
    ],
  );
}

/**
 * Look up an entity by a name-variant. Returns the best match (confirmed
 * aliases first, then most recent).
 */
export async function lookupEntityByName(
  db: DbClient,
  raw: string,
  kind?: EntityKind,
): Promise<StoredEntity | null> {
  const normalized = normalizeEntityName(raw);
  const rows = kind
    ? await db.query<EntityRow>(
        `SELECT e.entity_id, e.kind, e.external_id, e.display, e.metadata
         FROM entity_aliases a
         JOIN entities e ON e.entity_id = a.entity_id
         WHERE a.normalized = ? AND e.kind = ?
         ORDER BY a.confirmed DESC, a.created_at DESC
         LIMIT 1`,
        [normalized, kind],
      )
    : await db.query<EntityRow>(
        `SELECT e.entity_id, e.kind, e.external_id, e.display, e.metadata
         FROM entity_aliases a
         JOIN entities e ON e.entity_id = a.entity_id
         WHERE a.normalized = ?
         ORDER BY a.confirmed DESC, a.created_at DESC
         LIMIT 1`,
        [normalized],
      );
  return rows[0] ? toStoredEntity(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Filings (mirror of LDA filings we've fetched)
// ---------------------------------------------------------------------------

export async function upsertFiling(db: DbClient, f: Filing): Promise<void> {
  await db.run(
    `INSERT INTO filings (
       filing_uuid, filing_type, filing_year, filing_period,
       registrant_id, registrant_name, client_id, client_name,
       income, expenses, posted_at, document_url, raw_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(filing_uuid) DO UPDATE SET
       filing_type     = excluded.filing_type,
       filing_year     = excluded.filing_year,
       filing_period   = excluded.filing_period,
       registrant_id   = excluded.registrant_id,
       registrant_name = excluded.registrant_name,
       client_id       = excluded.client_id,
       client_name     = excluded.client_name,
       income          = excluded.income,
       expenses        = excluded.expenses,
       posted_at       = excluded.posted_at,
       document_url    = excluded.document_url,
       raw_json        = excluded.raw_json,
       fetched_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [
      f.filing_uuid,
      f.filing_type,
      f.filing_year,
      f.filing_period ?? null,
      f.registrant.id,
      f.registrant.name,
      f.client.id,
      f.client.name,
      f.income === null || f.income === undefined || f.income === ""
        ? null
        : Number.parseFloat(f.income),
      f.expenses === null || f.expenses === undefined || f.expenses === ""
        ? null
        : Number.parseFloat(f.expenses),
      f.dt_posted ?? null,
      f.filing_document_url ?? null,
      JSON.stringify(f),
    ],
  );
}

export async function upsertFilingsBatch(db: DbClient, filings: Filing[]): Promise<void> {
  if (filings.length === 0) return;
  await db.transaction(async (tx) => {
    for (const f of filings) {
      await upsertFiling(tx, f);

      // Opportunistically grow the entity + alias graph from every filing we
      // see. Must upsert the entity first — alias has a FK to entities.
      await upsertEntity(tx, {
        kind: "client",
        id: String(f.client.id),
        display: f.client.name,
        external_id: String(f.client.id),
        metadata: {
          state: f.client.state ?? null,
          country: f.client.country ?? null,
          client_government_entity: f.client.client_government_entity ?? null,
        },
      });
      await upsertEntityAlias(tx, {
        entity_id: entityKey("client", String(f.client.id)),
        raw: f.client.name,
        source: "lda",
      });

      await upsertEntity(tx, {
        kind: "registrant",
        id: String(f.registrant.id),
        display: f.registrant.name,
        external_id: String(f.registrant.id),
        metadata: {
          city: f.registrant.city ?? null,
          state: f.registrant.state ?? null,
          country: f.registrant.country ?? null,
        },
      });
      await upsertEntityAlias(tx, {
        entity_id: entityKey("registrant", String(f.registrant.id)),
        raw: f.registrant.name,
        source: "lda",
      });
    }
  });
}

/**
 * Read-back helper: all mirrored filings for a client, newest first.
 *
 * In LDA a `client_id` identifies a client-firm relationship, not a
 * company. To get all of a company's mirrored filings, pass `clientName`
 * (substring, case-insensitive). Pass `clientId` only for a specific
 * relationship. If both are given, clientId wins.
 */
export async function listFilingsForClient(
  db: DbClient,
  opts: {
    clientName?: string;
    clientId?: number;
    yearStart?: number;
    yearEnd?: number;
  },
): Promise<Filing[]> {
  if (opts.clientName === undefined && opts.clientId === undefined) {
    throw new Error("listFilingsForClient requires either clientName or clientId");
  }
  const rows = opts.clientId !== undefined
    ? await db.query<{ raw_json: string }>(
        `SELECT raw_json FROM filings
         WHERE client_id = ?
           AND (? IS NULL OR filing_year >= ?)
           AND (? IS NULL OR filing_year <= ?)
         ORDER BY filing_year DESC, filing_period DESC`,
        [
          opts.clientId,
          opts.yearStart ?? null,
          opts.yearStart ?? null,
          opts.yearEnd ?? null,
          opts.yearEnd ?? null,
        ],
      )
    : await db.query<{ raw_json: string }>(
        `SELECT raw_json FROM filings
         WHERE LOWER(client_name) LIKE LOWER(?)
           AND (? IS NULL OR filing_year >= ?)
           AND (? IS NULL OR filing_year <= ?)
         ORDER BY filing_year DESC, filing_period DESC`,
        [
          `%${opts.clientName}%`,
          opts.yearStart ?? null,
          opts.yearStart ?? null,
          opts.yearEnd ?? null,
          opts.yearEnd ?? null,
        ],
      );
  return rows.map((r) => JSON.parse(r.raw_json) as Filing);
}

/** Spend total for a client across a year range. Filed dollars only. */
export async function totalSpendForClient(
  db: DbClient,
  opts: {
    clientName?: string;
    clientId?: number;
    yearStart?: number;
    yearEnd?: number;
  },
): Promise<number> {
  const filings = await listFilingsForClient(db, opts);
  let total = 0;
  for (const f of filings) {
    const spend = filingSpend(f);
    if (spend !== null) total += spend;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

interface BriefRow {
  brief_id: number;
  entity_id: string;
  skill: string;
  window_key: string;
  year_start: number;
  year_end: number;
  quarter: number | null;
  generated_at: string;
  schema_version: number;
  envelope_json: string;
  markdown: string;
}

export async function saveBrief<TData>(db: DbClient, brief: Brief<TData>): Promise<void> {
  const entity_id = entityKey(brief.entity.kind, brief.entity.id);
  await db.run(
    `INSERT INTO briefs (
       entity_id, skill, window_key, year_start, year_end, quarter,
       generated_at, schema_version, envelope_json, markdown
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, skill, window_key) DO UPDATE SET
       year_start     = excluded.year_start,
       year_end       = excluded.year_end,
       quarter        = excluded.quarter,
       generated_at   = excluded.generated_at,
       schema_version = excluded.schema_version,
       envelope_json  = excluded.envelope_json,
       markdown       = excluded.markdown`,
    [
      entity_id,
      brief.skill,
      windowKey(brief.window),
      brief.window.year_start,
      brief.window.year_end,
      brief.window.quarter ?? null,
      brief.generated_at,
      brief.schema_version,
      JSON.stringify(brief),
      brief.markdown,
    ],
  );
}

export async function loadLatestBrief<TData>(
  db: DbClient,
  opts: { entity_id: string; skill: string; window_key?: string },
): Promise<Brief<TData> | null> {
  const rows = opts.window_key !== undefined
    ? await db.query<BriefRow>(
        `SELECT * FROM briefs WHERE entity_id = ? AND skill = ? AND window_key = ? ORDER BY generated_at DESC LIMIT 1`,
        [opts.entity_id, opts.skill, opts.window_key],
      )
    : await db.query<BriefRow>(
        `SELECT * FROM briefs WHERE entity_id = ? AND skill = ? ORDER BY year_end DESC, generated_at DESC LIMIT 1`,
        [opts.entity_id, opts.skill],
      );
  if (!rows[0]) return null;
  return JSON.parse(rows[0].envelope_json) as Brief<TData>;
}

export async function listBriefsForEntity(
  db: DbClient,
  entity_id: string,
): Promise<Array<{ skill: string; window_key: string; generated_at: string; schema_version: number }>> {
  return db.query(
    `SELECT skill, window_key, generated_at, schema_version FROM briefs WHERE entity_id = ? ORDER BY generated_at DESC`,
    [entity_id],
  );
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export interface Annotation {
  annotation_id: number;
  entity_id: string;
  created_at: string;
  note: string;
}

export async function addAnnotation(
  db: DbClient,
  entity_id: string,
  note: string,
): Promise<void> {
  await db.run(`INSERT INTO annotations (entity_id, note) VALUES (?, ?)`, [entity_id, note]);
}

export async function listAnnotations(
  db: DbClient,
  entity_id: string,
): Promise<Annotation[]> {
  return db.query<Annotation>(
    `SELECT annotation_id, entity_id, created_at, note FROM annotations WHERE entity_id = ? ORDER BY created_at ASC`,
    [entity_id],
  );
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export async function addToWatchlist(
  db: DbClient,
  entity_id: string,
  window_key: string,
): Promise<void> {
  await db.run(
    `INSERT INTO watchlist (entity_id, window_key) VALUES (?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET window_key = excluded.window_key`,
    [entity_id, window_key],
  );
}

export async function removeFromWatchlist(db: DbClient, entity_id: string): Promise<void> {
  await db.run(`DELETE FROM watchlist WHERE entity_id = ?`, [entity_id]);
}

export async function listWatchlist(
  db: DbClient,
): Promise<Array<{ entity_id: string; window_key: string; added_at: string }>> {
  return db.query(
    `SELECT entity_id, window_key, added_at FROM watchlist ORDER BY added_at ASC`,
  );
}
