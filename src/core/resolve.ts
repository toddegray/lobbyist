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
  normalizeEntityName,
  upsertEntity,
  upsertEntityAlias,
} from "../db/repos.ts";
import { jaroWinkler } from "./fuzzy.ts";

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
 *   2. Else, normalize-equality on stripped legal-suffix form (Pfizer Inc ≡ Pfizer).
 *   3. Else, substring containment + shortest wins.
 *   4. Else, Jaro–Winkler similarity on normalized names (threshold 0.8).
 *   5. Else, first hit (last-resort).
 *
 * This is the moat work: repeated queries for the same concept get smarter
 * as the alias graph grows, and the fuzzy fallback catches punctuation-level
 * variants OpenSecrets-era tools never would.
 */
function pickBestClientMatch(hits: Client[], raw: string): Client {
  return pickBestNamed(hits, raw);
}

function pickBestRegistrantMatch(hits: Registrant[], raw: string): Registrant {
  return pickBestNamed(hits, raw);
}

function pickBestNamed<T extends { name: string }>(hits: T[], raw: string): T {
  const needle = raw.toLowerCase().trim();
  const normalizedNeedle = normalizeEntityName(raw);

  // 1. Exact case-insensitive
  const exact = hits.find((h) => h.name.toLowerCase().trim() === needle);
  if (exact) return exact;

  // 2. Normalized equality
  const normMatch = hits.find((h) => normalizeEntityName(h.name) === normalizedNeedle);
  if (normMatch) return normMatch;

  // 3. Substring (shortest wins)
  const contains = hits
    .filter((h) => h.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (contains) return contains;

  // 4. Jaro–Winkler against normalized names
  let best: T | null = null;
  let bestScore = 0.8;      // threshold
  for (const h of hits) {
    const s = jaroWinkler(normalizedNeedle, normalizeEntityName(h.name));
    if (s > bestScore) {
      bestScore = s;
      best = h;
    }
  }
  if (best) return best;

  // 5. Last-resort
  return hits[0]!;
}
