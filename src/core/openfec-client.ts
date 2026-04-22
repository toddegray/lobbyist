/**
 * OpenFEC API client.
 *
 * NOTE: This file is a deliberate, user-approved port from fec-analyst. The
 * rate-limit + cooldown + retry + on-disk cache surface is a solved problem
 * there, and re-implementing it in lobbyist would be make-work. If you change
 * behavior here, mirror the change into fec-analyst or document the drift.
 *
 * Backed by api.data.gov. The public base is https://api.open.fec.gov/v1/.
 * Every call:
 *   - appends api_key from the resolved config
 *   - is rate-limited to config.openfec_rate_limit_rps (serialized, not bursted)
 *   - is cached on disk under config.cache_dir, keyed by path + sorted params,
 *     so repeated runs of the same brief don't burn the 1000/hr quota
 *   - parses the response with a caller-supplied zod schema
 *   - surfaces api.data.gov rate-limit headers on 429 so the user sees the
 *     actual window instead of a generic failure
 *
 * The client does not know about candidates, committees, or donors. It only
 * knows how to GET an OpenFEC endpoint and return typed JSON. Skill code is
 * where entity semantics live.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";

const BASE_URL = "https://api.open.fec.gov/v1";
const USER_AGENT = "lobbyist (https://github.com/toddegray/lobbyist)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenFecClientOptions {
  apiKey: string;
  cacheDir: string;
  /** Max requests per second. Serialized; no bursting. */
  rateLimitRps: number;
  /**
   * Cache TTL in seconds. null = cache forever (useful for stable historical
   * cycles). Defaults to 24h, which is plenty for a development loop.
   */
  cacheTtlSeconds?: number | null;
  /** Override the base URL (tests). */
  baseUrl?: string;
}

/** A primitive query-param value. Arrays are serialized as repeated keys. */
export type QueryValue = string | number | boolean | Array<string | number>;
export type Query = Record<string, QueryValue | undefined>;

export class OpenFecError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "OpenFecError";
  }
}

// ---------------------------------------------------------------------------
// Rate limiter: serializes requests so they fire no faster than rps.
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

function serializeQuery(q: Query): string {
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
  // api_key is excluded from the cache key — the same endpoint + params
  // returns the same data regardless of which key called it.
  return createHash("sha256")
    .update(`${path}?${query}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface CacheEnvelope {
  fetched_at: string;
  status: number;
  body: unknown;
}

export class OpenFecClient {
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number | null;
  /**
   * Cooldown gate. When we see X-RateLimit-Remaining near zero, or a 429,
   * we set this to the epoch-ms after which it's safe to fire again. Every
   * call awaits this gate before acquiring its rate-limiter slot.
   */
  private cooldownUntil = 0;

  constructor(private readonly opts: OpenFecClientOptions) {
    this.limiter = new RateLimiter(opts.rateLimitRps);
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.cacheTtlMs =
      opts.cacheTtlSeconds === undefined
        ? 24 * 3600 * 1000
        : opts.cacheTtlSeconds === null
          ? null
          : opts.cacheTtlSeconds * 1000;
  }

  private async awaitCooldown(): Promise<void> {
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** On 429 with no explicit reset header, back off 65s (one full minute window). */
  private setCooldown(seconds: number): void {
    const next = Date.now() + seconds * 1000;
    if (next > this.cooldownUntil) this.cooldownUntil = next;
  }

  /**
   * GET an OpenFEC path (e.g. "/candidates/search", "/committee/C00401224").
   * Leading slash optional. Returns parsed JSON validated against `schema`.
   */
  async get<T>(
    path: string,
    query: Query,
    schema: ZodType<T>,
    opts: { bypassCache?: boolean } = {},
  ): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = serializeQuery(query);
    const key = cacheKey(normalizedPath, qs);
    const cacheFile = join(this.opts.cacheDir, "openfec", `${key}.json`);

    if (!opts.bypassCache) {
      const cached = await this.readCache(cacheFile);
      if (cached) return this.parse(schema, cached.body, normalizedPath);
    }

    const url = `${this.baseUrl}${normalizedPath}?${qs}${qs ? "&" : ""}api_key=${encodeURIComponent(this.opts.apiKey)}`;

    // Retry loop for 429s: api.data.gov rate-limits at 60/min/key.
    // On 429 we back off 65s (one full window) and try again, up to 3 total tries.
    // Non-429 non-OK responses fail fast — those are real errors, not pacing issues.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.awaitCooldown();
      await this.limiter.acquire();

      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      });
      const body = await res.json().catch(() => null);

      const remainingRaw = res.headers.get("x-ratelimit-remaining");
      if (remainingRaw != null) {
        const remaining = Number.parseInt(remainingRaw, 10);
        if (Number.isFinite(remaining) && remaining <= 2) {
          this.setCooldown(65);
        }
      }

      if (res.status === 429 && attempt < maxAttempts) {
        const resetRaw = res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after");
        const resetSec = resetRaw ? Math.min(Number.parseInt(resetRaw, 10) || 65, 120) : 65;
        this.setCooldown(resetSec);
        continue;
      }

      if (!res.ok) {
        const hint =
          res.status === 429
            ? ` — rate limit exhausted after ${attempt} attempts. X-RateLimit-Remaining: ${res.headers.get("x-ratelimit-remaining") ?? "?"}, reset: ${res.headers.get("x-ratelimit-reset") ?? "?"}`
            : res.status === 403
              ? " — likely a bad or revoked API key"
              : "";
        throw new OpenFecError(
          `OpenFEC ${res.status} on GET ${normalizedPath}${hint}`,
          res.status,
          url.replace(/api_key=[^&]+/, "api_key=<redacted>"),
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
    throw new OpenFecError(
      `OpenFEC retries exhausted on GET ${normalizedPath}`,
      429,
      normalizedPath,
      null,
    );
  }

  private parse<T>(schema: ZodType<T>, body: unknown, path: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OpenFecError(
        `OpenFEC response from ${path} did not match schema:\n${parsed.error.issues
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
