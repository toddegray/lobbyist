/**
 * lobbyist configuration.
 *
 * Resolution order (first match wins):
 *   1. Env var (LOBBYIST_LDA_API_KEY, LOBBYIST_OPENFEC_API_KEY, ...)
 *   2. ~/.lobbyist/config.json (or $LOBBYIST_CONFIG_PATH)
 *   3. Built-in defaults
 *
 * The config file is the front door. Env vars are the escape hatch (CI,
 * headless deploys, per-run overrides). Nothing a user might plausibly want
 * to change is env-var-only.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".lobbyist", "config.json");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const OperatorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

const ConfigSchema = z.object({
  version: z.literal(1),
  operator: OperatorSchema,
  /** Senate LDA API key from lda.senate.gov/api/register/. Required. */
  lda_api_key: z.string().min(10),
  /**
   * OpenFEC API key from api.open.fec.gov/developers/. Optional at v0.1,
   * required in v0.5 for LDA + FEC cross-reference skills.
   */
  openfec_api_key: z.string().nullable().default(null),
  /**
   * USASpending.gov does not require an API key today. Field reserved for
   * future-proofing if they add auth.
   */
  usaspending_api_key: z.string().nullable().default(null),
  /**
   * Congress.gov API key. Shares api.data.gov's key space with OpenFEC, so
   * users typically set a single api.data.gov key and leave this null; we
   * fall back to openfec_api_key in resolveConfig().
   */
  congress_api_key: z.string().nullable().default(null),
  /** Directory where fetched API payloads are cached. */
  cache_dir: z.string().min(1).optional(),
  /** Directory where the SQLite file lives. */
  data_dir: z.string().min(1).optional(),
  /**
   * Max LDA requests per second. The Senate LDA API is documented as allowing
   * burst traffic up to a few hundred authenticated requests per minute, but
   * we stay conservative. Default 1 rps (60/min).
   */
  lda_rate_limit_rps: z.number().min(0.1).max(10).default(1),
  /**
   * Max OpenFEC requests per second. api.data.gov returns
   * `x-ratelimit-limit: 60` per minute, i.e. 1 rps exactly — no headroom.
   * Default 0.8 rps keeps a buffer for upstream latency variance.
   */
  openfec_rate_limit_rps: z.number().min(0.1).max(10).default(0.8),
  /**
   * Default year range for skills that don't specify. Lobbying data is
   * quarterly, not biennial, so we think in years.
   */
  default_year_start: z.number().int().min(1999).max(2100).default(2020),
  default_year_end: z.number().int().min(1999).max(2100).default(2024),
  /** Default watchlist entities (entity_ids or free-text names). */
  watchlist: z.array(z.string()).default([]),
  /**
   * Anthropic API key for narrative synthesis. Optional on disk — env var
   * ANTHROPIC_API_KEY overrides, and structured-only runs work without it.
   */
  anthropic_api_key: z.string().nullable().default(null),
  /** Default Anthropic model for synthesis. */
  anthropic_model: z.string().default("claude-opus-4-7"),
});

export type LobbyistConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedConfig
  extends Omit<LobbyistConfig, "cache_dir" | "data_dir"> {
  /** Guaranteed non-null after resolution. */
  cache_dir: string;
  /** Guaranteed non-null after resolution. */
  data_dir: string;
  /** The path the config was loaded from, if any. */
  source_path: string | null;
  /** Resolved LDA key (env > config). */
  resolved_lda_key: string;
  /** Resolved OpenFEC key (env > config). May be null at v0.1. */
  resolved_openfec_key: string | null;
  /** Resolved Congress.gov key (env > config.congress > config.openfec — same api.data.gov key space). */
  resolved_congress_key: string | null;
  /** Resolved Anthropic key (env > config). May be null for structured-only commands. */
  resolved_anthropic_key: string | null;
}

export function configPath(): string {
  return process.env.LOBBYIST_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

function defaultCacheDir(): string {
  return process.env.LOBBYIST_CACHE_DIR || join(homedir(), ".lobbyist", "cache");
}

function defaultDataDir(): string {
  return process.env.LOBBYIST_DATA_DIR || join(homedir(), ".lobbyist", "data");
}

export async function readConfigFile(path = configPath()): Promise<LobbyistConfig | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const raw = await file.json().catch(() => null);
  if (!raw) return null;
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Config file at ${path} is invalid:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  return parsed.data;
}

export async function writeConfigFile(
  config: LobbyistConfig,
  path = configPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Resolve the effective config, applying env-var overrides on top of the
 * persisted file. Throws with an actionable message if no LDA key is
 * available — the API requires one on every authenticated call.
 */
export async function resolveConfig(): Promise<ResolvedConfig> {
  const path = configPath();
  const fileConfig = await readConfigFile(path);

  const ldaKey = process.env.LOBBYIST_LDA_API_KEY || fileConfig?.lda_api_key || null;
  if (!ldaKey) {
    throw new Error(
      [
        "lobbyist is not configured.",
        "",
        "The Senate LDA API requires a key for anything above the public rate tier.",
        "Get one (free, instant) at https://lda.senate.gov/api/register/ — then run:",
        "",
        "  lobbyist init",
        "",
        "Or set LOBBYIST_LDA_API_KEY for one-off use.",
      ].join("\n"),
    );
  }

  const merged: LobbyistConfig = {
    version: 1,
    operator: {
      name: fileConfig?.operator.name ?? "lobbyist",
      email: fileConfig?.operator.email ?? "unset@example.invalid",
    },
    lda_api_key: ldaKey,
    openfec_api_key:
      process.env.LOBBYIST_OPENFEC_API_KEY || fileConfig?.openfec_api_key || null,
    usaspending_api_key: fileConfig?.usaspending_api_key ?? null,
    congress_api_key:
      process.env.LOBBYIST_CONGRESS_API_KEY ||
      fileConfig?.congress_api_key ||
      null,
    cache_dir:
      process.env.LOBBYIST_CACHE_DIR || fileConfig?.cache_dir || defaultCacheDir(),
    data_dir:
      process.env.LOBBYIST_DATA_DIR || fileConfig?.data_dir || defaultDataDir(),
    lda_rate_limit_rps: fileConfig?.lda_rate_limit_rps ?? 1,
    openfec_rate_limit_rps: fileConfig?.openfec_rate_limit_rps ?? 0.8,
    default_year_start: fileConfig?.default_year_start ?? 2020,
    default_year_end: fileConfig?.default_year_end ?? 2024,
    watchlist: fileConfig?.watchlist ?? [],
    anthropic_api_key: fileConfig?.anthropic_api_key ?? null,
    anthropic_model: fileConfig?.anthropic_model ?? "claude-opus-4-7",
  };

  const resolved_anthropic_key =
    process.env.ANTHROPIC_API_KEY || merged.anthropic_api_key || null;

  // Congress.gov shares api.data.gov's key space with OpenFEC — fall back
  // to the OpenFEC key if the user only configured one. Explicit
  // LOBBYIST_CONGRESS_API_KEY or congress_api_key wins.
  const resolved_congress_key =
    merged.congress_api_key || merged.openfec_api_key || null;

  return {
    ...merged,
    cache_dir: merged.cache_dir!,
    data_dir: merged.data_dir!,
    source_path: fileConfig ? path : null,
    resolved_lda_key: ldaKey,
    resolved_openfec_key: merged.openfec_api_key,
    resolved_congress_key,
    resolved_anthropic_key,
  };
}

// ---------------------------------------------------------------------------
// Pure helper: build a config object from init answers (separate from I/O
// so init can be tested without prompting real stdin).
// ---------------------------------------------------------------------------

export function buildConfig(input: {
  operator_name: string;
  operator_email: string;
  lda_api_key: string;
  openfec_api_key?: string | null;
  cache_dir?: string;
  data_dir?: string;
  lda_rate_limit_rps?: number;
  openfec_rate_limit_rps?: number;
  default_year_start?: number;
  default_year_end?: number;
  watchlist?: string[];
  anthropic_api_key?: string | null;
  anthropic_model?: string;
}): LobbyistConfig {
  return ConfigSchema.parse({
    version: 1,
    operator: {
      name: input.operator_name,
      email: input.operator_email,
    },
    lda_api_key: input.lda_api_key,
    openfec_api_key: input.openfec_api_key ?? null,
    usaspending_api_key: null,
    congress_api_key: null,
    cache_dir: input.cache_dir ?? defaultCacheDir(),
    data_dir: input.data_dir ?? defaultDataDir(),
    lda_rate_limit_rps: input.lda_rate_limit_rps ?? 1,
    openfec_rate_limit_rps: input.openfec_rate_limit_rps ?? 0.8,
    default_year_start: input.default_year_start ?? 2020,
    default_year_end: input.default_year_end ?? 2024,
    watchlist: input.watchlist ?? [],
    anthropic_api_key: input.anthropic_api_key ?? null,
    anthropic_model: input.anthropic_model ?? "claude-opus-4-7",
  });
}
