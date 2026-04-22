/**
 * Entity resolution helpers.
 *
 * First pass of the entity-resolution graph. Given a free-text name, try:
 *   1. Local alias lookup (DB) — free if we've seen this name before.
 *   2. LDA client search — grow the graph for next time.
 *
 * When the LDA returns multiple candidates, we return the first one and
 * persist the alias as unconfirmed. Skills that want strict single-match
 * semantics can check the returned candidate_count and prompt.
 */

import type { LdaClient } from "./lda-client.ts";
import { searchClients, searchRegistrants, type Client, type Registrant } from "./lda-endpoints.ts";
import type { DbClient } from "../db/engine.ts";
import {
  entityKey,
  lookupEntityByName,
  upsertEntity,
  upsertEntityAlias,
} from "../db/repos.ts";

export interface ClientResolution {
  client_id: number;
  name: string;
  source: "cache" | "lda";
  candidate_count: number;
}

/**
 * Resolve a free-text client name to a concrete LDA client_id. Tries memory
 * first, then LDA search. Persists the alias either way.
 */
export async function resolveClient(
  db: DbClient,
  lda: LdaClient,
  raw: string,
): Promise<ClientResolution | null> {
  const cached = await lookupEntityByName(db, raw, "client");
  if (cached && cached.external_id) {
    const n = Number.parseInt(cached.external_id, 10);
    if (Number.isFinite(n)) {
      await upsertEntityAlias(db, {
        entity_id: cached.kind + ":" + cached.id,
        raw,
        source: "user",
      });
      return { client_id: n, name: cached.display, source: "cache", candidate_count: 1 };
    }
  }

  const hits = await searchClients(lda, raw, { pageSize: 25 });
  if (hits.length === 0) return null;

  const best = pickBestClientMatch(hits, raw);
  const entity_id = entityKey("client", String(best.id));
  await upsertEntity(db, {
    kind: "client",
    id: String(best.id),
    display: best.name,
    external_id: String(best.id),
    metadata: {
      general_description: best.general_description ?? null,
      state: best.state ?? null,
      country: best.country ?? null,
      client_government_entity: best.client_government_entity ?? null,
    },
  });
  await upsertEntityAlias(db, { entity_id, raw: best.name, source: "lda" });
  if (raw !== best.name) {
    await upsertEntityAlias(db, { entity_id, raw, source: "user" });
  }

  return {
    client_id: best.id,
    name: best.name,
    source: "lda",
    candidate_count: hits.length,
  };
}

/**
 * Resolve a free-text registrant (lobbying firm) name to an LDA registrant_id.
 */
export async function resolveRegistrant(
  db: DbClient,
  lda: LdaClient,
  raw: string,
): Promise<{ registrant_id: number; name: string; source: "cache" | "lda"; candidate_count: number } | null> {
  const cached = await lookupEntityByName(db, raw, "registrant");
  if (cached && cached.external_id) {
    const n = Number.parseInt(cached.external_id, 10);
    if (Number.isFinite(n)) {
      return { registrant_id: n, name: cached.display, source: "cache", candidate_count: 1 };
    }
  }

  const hits = await searchRegistrants(lda, raw, { pageSize: 25 });
  if (hits.length === 0) return null;

  const best = pickBestRegistrantMatch(hits, raw);
  const entity_id = entityKey("registrant", String(best.id));
  await upsertEntity(db, {
    kind: "registrant",
    id: String(best.id),
    display: best.name,
    external_id: String(best.id),
    metadata: {
      description: best.description ?? null,
      city: best.city ?? null,
      state: best.state ?? null,
      country: best.country ?? null,
    },
  });
  await upsertEntityAlias(db, { entity_id, raw: best.name, source: "lda" });
  if (raw !== best.name) {
    await upsertEntityAlias(db, { entity_id, raw, source: "user" });
  }

  return {
    registrant_id: best.id,
    name: best.name,
    source: "lda",
    candidate_count: hits.length,
  };
}

/**
 * Heuristic "best match" for a client search:
 *   1. Exact case-insensitive name match wins.
 *   2. Else, shortest name containing the query (preferring the canonical
 *      entity over a subsidiary variant).
 *   3. Else, first hit.
 */
function pickBestClientMatch(hits: Client[], raw: string): Client {
  const needle = raw.toLowerCase().trim();
  const exact = hits.find((h) => h.name.toLowerCase().trim() === needle);
  if (exact) return exact;
  const contains = hits
    .filter((h) => h.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.length - b.name.length)[0];
  return contains ?? hits[0]!;
}

function pickBestRegistrantMatch(hits: Registrant[], raw: string): Registrant {
  const needle = raw.toLowerCase().trim();
  const exact = hits.find((h) => h.name.toLowerCase().trim() === needle);
  if (exact) return exact;
  const contains = hits
    .filter((h) => h.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.length - b.name.length)[0];
  return contains ?? hits[0]!;
}
