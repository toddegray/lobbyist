/**
 * Senate LDA (Lobbying Disclosure Act) API client.
 *
 * Base: https://lda.senate.gov/api/v1/
 *   (migrating to https://lda.gov/api/v1/ on 2026-06-30 — see LDA_BASE_URL_FALLBACKS)
 *
 * The API is Django REST Framework; responses are paginated as
 *   { count, next, previous, results: [...] }.
 *
 * Auth: the API exposes an anonymous tier (capped at roughly 15 req/min per
 * IP) and an authenticated tier (roughly 120 req/min). We always send the
 * token when one is configured. Header form:
 *     Authorization: Token <api_key>
 *
 * Every call:
 *   - is rate-limited to config.lda_rate_limit_rps (serialized, not bursted)
 *   - is cached on disk under cache_dir/lda/, keyed by path + sorted params
 *   - parses the response with a caller-supplied zod schema
 *   - retries once on 429 with a one-minute cooldown
 *
 * The client knows nothing about registrants, clients, or filings. Skill code
 * is where entity semantics live.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";

const LDA_BASE_URL = "https://lda.senate.gov/api/v1";
/** Fallback base URLs to try if the primary 404s. Order matters. */
export const LDA_BASE_URL_FALLBACKS = [
  "https://lda.senate.gov/api/v1",
  "https://lda.gov/api/v1",
];
const USER_AGENT = "lobbyist (https://github.com/toddegray/lobbyist)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LdaClientOptions {
  /** LDA API token (from lda.senate.gov/api/register/). Required. */
  apiKey: string;
  /** Directory where response bodies are cached. The client creates `lda/` underneath. */
  cacheDir: string;
  /** Max requests per second. Serialized; no bursting. */
  rateLimitRps: number;
  /**
   * Cache TTL in seconds. null = cache forever (safe for historical quarters
   * that no longer receive amendments). Defaults to 24h.
   */
  cacheTtlSeconds?: number | null;
  /** Override the base URL (tests, or for the 2026-06-30 migration). */
  baseUrl?: string;
}

/** A primitive query-param value. Arrays are serialized as repeated keys. */
export type LdaQueryValue = string | number | boolean | Array<string | number>;
export type LdaQuery = Record<string, LdaQueryValue | undefined>;

export class LdaError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "LdaError";
  }
}

/**
 * DRF's paginated list envelope. `results` is caller-typed.
 */
export interface LdaPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ---------------------------------------------------------------------------
// Rate limiter (identical shape to OpenFecClient's — single-file copy is
// intentional; both clients will eventually share a ratelimit/ module)
// ---------------------------------------------------------------------------

class RateLimiter {
  private chain: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;
  private lastStart = 0;

  constructor(rps: number) {
    this.minIntervalMs = Math.ceil(1000 / Math.max(rps, 0.1));
  }

  async acquire(): Promise<void> {
    const slot = this.chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.minIntervalMs - (now - this.lastStart));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
    });
    this.chain = slot.catch(() => {});
    return slot;
  }
}

// ---------------------------------------------------------------------------
// Query serialization
// ---------------------------------------------------------------------------

function serializeQuery(q: LdaQuery): string {
  const params = new URLSearchParams();
  const keys = Object.keys(q).sort();
  for (const key of keys) {
    const v = q[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(key, String(item));
    } else {
      params.append(key, String(v));
    }
  }
  return params.toString();
}

function cacheKey(path: string, query: string): string {
  return createHash("sha256")
    .update(`${path}?${query}`)
    .digest("hex")
    .slice(0, 16);
}

interface CacheEnvelope {
  fetched_at: string;
  status: number;
  body: unknown;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class LdaClient {
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number | null;
  private cooldownUntil = 0;

  constructor(private readonly opts: LdaClientOptions) {
    this.limiter = new RateLimiter(opts.rateLimitRps);
    this.baseUrl = opts.baseUrl ?? LDA_BASE_URL;
    this.cacheTtlMs =
      opts.cacheTtlSeconds === undefined
        ? 24 * 3600 * 1000
        : opts.cacheTtlSeconds === null
          ? null
          : opts.cacheTtlSeconds * 1000;
  }

  private async awaitCooldown(): Promise<void> {
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private setCooldown(seconds: number): void {
    const next = Date.now() + seconds * 1000;
    if (next > this.cooldownUntil) this.cooldownUntil = next;
  }

  /**
   * GET an LDA path (e.g. "/filings/", "/registrants/12345/").
   * Leading slash optional. Returns parsed JSON validated against `schema`.
   */
  async get<T>(
    path: string,
    query: LdaQuery,
    schema: ZodType<T>,
    opts: { bypassCache?: boolean } = {},
  ): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = serializeQuery(query);
    const key = cacheKey(normalizedPath, qs);
    const cacheFile = join(this.opts.cacheDir, "lda", `${key}.json`);

    if (!opts.bypassCache) {
      const cached = await this.readCache(cacheFile);
      if (cached) return this.parse(schema, cached.body, normalizedPath);
    }

    const url = `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.awaitCooldown();
      await this.limiter.acquire();

      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Token ${this.opts.apiKey}`,
          "user-agent": USER_AGENT,
        },
      });
      const body = await res.json().catch(() => null);

      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfter = res.headers.get("retry-after");
        const resetSec = retryAfter
          ? Math.min(Number.parseInt(retryAfter, 10) || 65, 300)
          : 65;
        this.setCooldown(resetSec);
        continue;
      }

      if (!res.ok) {
        const hint =
          res.status === 429
            ? ` — rate limit exhausted after ${attempt} attempts`
            : res.status === 401 || res.status === 403
              ? " — likely a bad or revoked LDA API token"
              : res.status === 404
                ? " — endpoint not found (the LDA API is migrating to lda.gov on 2026-06-30; try updating base_url)"
                : "";
        throw new LdaError(
          `LDA ${res.status} on GET ${normalizedPath}${hint}`,
          res.status,
          url,
          body,
        );
      }

      await this.writeCache(cacheFile, {
        fetched_at: new Date().toISOString(),
        status: res.status,
        body,
      });
      return this.parse(schema, body, normalizedPath);
    }

    throw new LdaError(
      `LDA retries exhausted on GET ${normalizedPath}`,
      429,
      normalizedPath,
      null,
    );
  }

  /**
   * Paginate through every page of a list endpoint. Walks the `next` URL
   * until it's null. `maxPages` guards against runaway queries; default 20
   * (typical skill should filter enough to land below this).
   */
  async paginate<T>(
    path: string,
    query: LdaQuery,
    pageSchema: ZodType<LdaPage<T>>,
    opts: { maxPages?: number } = {},
  ): Promise<T[]> {
    const maxPages = opts.maxPages ?? 20;
    const results: T[] = [];
    let page = 1;
    let q: LdaQuery = { ...query, page };
    while (page <= maxPages) {
      const envelope = await this.get(path, q, pageSchema);
      results.push(...envelope.results);
      if (!envelope.next) break;
      page += 1;
      q = { ...query, page };
    }
    return results;
  }

  private parse<T>(schema: ZodType<T>, body: unknown, path: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new LdaError(
        `LDA response from ${path} did not match schema:\n${parsed.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`,
        200,
        path,
        body,
      );
    }
    return parsed.data;
  }

  private async readCache(file: string): Promise<CacheEnvelope | null> {
    try {
      const raw = await readFile(file, "utf8");
      const envelope = JSON.parse(raw) as CacheEnvelope;
      if (this.cacheTtlMs !== null) {
        const age = Date.now() - Date.parse(envelope.fetched_at);
        if (age > this.cacheTtlMs) return null;
      }
      return envelope;
    } catch {
      return null;
    }
  }

  private async writeCache(file: string, envelope: CacheEnvelope): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(envelope));
  }
}
