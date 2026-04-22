/**
 * Congress.gov API client.
 *
 * Base: https://api.congress.gov/v3/
 *
 * Auth: api.data.gov key via `api_key` query param. The same key as OpenFEC
 * (and USDA, NASA, etc.) works here, but we support a dedicated key too so
 * users can rate-isolate their congress.gov traffic.
 *
 * Returns JSON. Pagination via `offset` + `limit`. Rate limit is the
 * standard api.data.gov 1000/hour / 60/minute envelope.
 *
 * The client is dumb (GET + parse + cache). Bill/member/committee semantics
 * live in congress-endpoints.ts.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";

const BASE_URL = "https://api.congress.gov/v3";
const USER_AGENT = "lobbyist (https://github.com/toddegray/lobbyist)";

export interface CongressClientOptions {
  apiKey: string;
  cacheDir: string;
  rateLimitRps: number;
  cacheTtlSeconds?: number | null;
  baseUrl?: string;
}

export type CongressQueryValue = string | number | boolean;
export type CongressQuery = Record<string, CongressQueryValue | undefined>;

export class CongressError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CongressError";
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

function serialize(q: CongressQuery): string {
  const p = new URLSearchParams();
  for (const k of Object.keys(q).sort()) {
    const v = q[k];
    if (v !== undefined) p.append(k, String(v));
  }
  return p.toString();
}

function cacheKey(path: string, qs: string): string {
  return createHash("sha256").update(`${path}?${qs}`).digest("hex").slice(0, 16);
}

interface CacheEnvelope {
  fetched_at: string;
  status: number;
  body: unknown;
}

export class CongressClient {
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number | null;
  private cooldownUntil = 0;

  constructor(private readonly opts: CongressClientOptions) {
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
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  private setCooldown(seconds: number): void {
    const n = Date.now() + seconds * 1000;
    if (n > this.cooldownUntil) this.cooldownUntil = n;
  }

  async get<T>(
    path: string,
    query: CongressQuery,
    schema: ZodType<T>,
    opts: { bypassCache?: boolean } = {},
  ): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = serialize({ ...query, format: "json" });
    const key = cacheKey(normalizedPath, qs);
    const cacheFile = join(this.opts.cacheDir, "congress", `${key}.json`);

    if (!opts.bypassCache) {
      const cached = await this.readCache(cacheFile);
      if (cached) return this.parse(schema, cached.body, normalizedPath);
    }

    const url = `${this.baseUrl}${normalizedPath}?${qs}&api_key=${encodeURIComponent(this.opts.apiKey)}`;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.awaitCooldown();
      await this.limiter.acquire();
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      const body = await res.json().catch(() => null);

      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining != null) {
        const n = Number.parseInt(remaining, 10);
        if (Number.isFinite(n) && n <= 2) this.setCooldown(65);
      }

      if (res.status === 429 && attempt < maxAttempts) {
        this.setCooldown(65);
        continue;
      }
      if (!res.ok) {
        throw new CongressError(
          `Congress.gov ${res.status} on GET ${normalizedPath}`,
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
    throw new CongressError(`Congress.gov retries exhausted on GET ${normalizedPath}`, 429, normalizedPath, null);
  }

  private parse<T>(schema: ZodType<T>, body: unknown, path: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new CongressError(
        `Congress.gov response from ${path} did not match schema:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`,
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
      const env = JSON.parse(raw) as CacheEnvelope;
      if (this.cacheTtlMs !== null) {
        const age = Date.now() - Date.parse(env.fetched_at);
        if (age > this.cacheTtlMs) return null;
      }
      return env;
    } catch {
      return null;
    }
  }
  private async writeCache(file: string, env: CacheEnvelope): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(env));
  }
}
