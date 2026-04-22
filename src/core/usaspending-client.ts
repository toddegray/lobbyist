/**
 * USASpending.gov API client.
 *
 * Base: https://api.usaspending.gov/api/v2/
 *
 * Unlike LDA and OpenFEC, USASpending has no authentication requirement and
 * no per-key quota. It does ask that clients be polite: the docs suggest
 * staying under a few requests per second from a single IP. We default to
 * 2 rps and cache aggressively — contract awards, once final, rarely change.
 *
 * The endpoints we consume are POST with JSON bodies (not GET with query
 * params like LDA/FEC), so the client signature differs slightly: `post(path,
 * body, schema)` instead of `get(path, query, schema)`.
 *
 * The client knows nothing about awards, recipients, or agencies. Skill code
 * is where domain semantics live.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";

const BASE_URL = "https://api.usaspending.gov/api/v2";
const USER_AGENT = "lobbyist (https://github.com/toddegray/lobbyist)";

export interface UsaSpendingClientOptions {
  /** No key needed today, but the field is reserved for future-proofing. */
  apiKey?: string | null;
  cacheDir: string;
  /** Default 2 rps. USASpending has no published quota but asks for politeness. */
  rateLimitRps: number;
  /** Cache TTL. Contract data is relatively stable; default 7 days. */
  cacheTtlSeconds?: number | null;
  baseUrl?: string;
}

export class UsaSpendingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "UsaSpendingError";
  }
}

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

function cacheKey(path: string, bodyJson: string): string {
  return createHash("sha256").update(`${path}\n${bodyJson}`).digest("hex").slice(0, 16);
}

interface CacheEnvelope {
  fetched_at: string;
  status: number;
  body: unknown;
}

export class UsaSpendingClient {
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number | null;

  constructor(private readonly opts: UsaSpendingClientOptions) {
    this.limiter = new RateLimiter(opts.rateLimitRps);
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.cacheTtlMs =
      opts.cacheTtlSeconds === undefined
        ? 7 * 24 * 3600 * 1000
        : opts.cacheTtlSeconds === null
          ? null
          : opts.cacheTtlSeconds * 1000;
  }

  /** POST with a JSON body; most USASpending search endpoints work this way. */
  async post<T>(
    path: string,
    body: unknown,
    schema: ZodType<T>,
    opts: { bypassCache?: boolean } = {},
  ): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const bodyJson = JSON.stringify(body, Object.keys(body as object).sort());
    const key = cacheKey(normalizedPath, bodyJson);
    const cacheFile = join(this.opts.cacheDir, "usaspending", `${key}.json`);

    if (!opts.bypassCache) {
      const cached = await this.readCache(cacheFile);
      if (cached) return this.parse(schema, cached.body, normalizedPath);
    }

    const url = `${this.baseUrl}${normalizedPath}`;
    await this.limiter.acquire();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
      },
      body: bodyJson,
    });
    const resBody = await res.json().catch(() => null);

    if (!res.ok) {
      throw new UsaSpendingError(
        `USASpending ${res.status} on POST ${normalizedPath}`,
        res.status,
        url,
        resBody,
      );
    }

    await this.writeCache(cacheFile, {
      fetched_at: new Date().toISOString(),
      status: res.status,
      body: resBody,
    });
    return this.parse(schema, resBody, normalizedPath);
  }

  /** GET with URL-encoded query params; used for the simpler endpoints. */
  async get<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: ZodType<T>,
    opts: { bypassCache?: boolean } = {},
  ): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const params = new URLSearchParams();
    const sortedKeys = Object.keys(query).sort();
    for (const k of sortedKeys) {
      const v = query[k];
      if (v !== undefined) params.append(k, String(v));
    }
    const qs = params.toString();
    const key = cacheKey(normalizedPath, qs);
    const cacheFile = join(this.opts.cacheDir, "usaspending", `${key}.json`);

    if (!opts.bypassCache) {
      const cached = await this.readCache(cacheFile);
      if (cached) return this.parse(schema, cached.body, normalizedPath);
    }

    const url = `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
    await this.limiter.acquire();

    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new UsaSpendingError(
        `USASpending ${res.status} on GET ${normalizedPath}`,
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

  private parse<T>(schema: ZodType<T>, body: unknown, path: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new UsaSpendingError(
        `USASpending response from ${path} did not match schema:\n${parsed.error.issues
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
