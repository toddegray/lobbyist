/**
 * lobbyist database engine backed by bun:sqlite.
 *
 * Synchronous under the hood; wrapped in an async surface so callers can
 * treat it like any other DB client. Migrations run forward-only on open.
 *
 * The Statement cache is load-bearing: bun:sqlite's Statement GC interacts
 * badly with preparing the same SQL inside a tight loop, manifesting as
 * "closed database" errors after a few iterations. Caching by SQL text keeps
 * the prepared statement alive for the lifetime of the client.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolvePath(HERE, "schema.sql");

export interface EngineConfig {
  /** Directory where the SQLite file lives. Created on first run. */
  dataDir: string;
}

export type DbRow = Record<string, unknown>;

/**
 * Narrow query surface. Callers go through typed repo functions — ad-hoc SQL
 * does not belong outside `src/db/`. The interface stays async so swapping
 * engines later (Turso, Postgres) doesn't ripple through call sites.
 */
export interface DbClient {
  query<T = DbRow>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// SQLite doesn't bind booleans or undefined — coerce at the edge.
function normalizeParams(params: unknown[]): SQLQueryBindings[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as SQLQueryBindings;
  });
}

class SqliteClient implements DbClient {
  private readonly stmtCache = new Map<string, ReturnType<Database["prepare"]>>();

  constructor(private readonly db: Database) {}

  private getStmt(sql: string): ReturnType<Database["prepare"]> {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  async query<T = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.getStmt(sql);
    return stmt.all(...normalizeParams(params)) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    const stmt = this.getStmt(sql);
    stmt.run(...normalizeParams(params));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    // bun:sqlite's db.transaction() expects a sync function. We run the body
    // with a manual BEGIN/COMMIT so the callback can remain async — async
    // skill code is the common case and forcing sync is a footgun.
    this.db.exec("BEGIN");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  async close(): Promise<void> {
    for (const stmt of this.stmtCache.values()) {
      try {
        stmt.finalize();
      } catch {}
    }
    this.stmtCache.clear();
    this.db.close();
  }
}

export async function openDb(cfg: EngineConfig): Promise<DbClient> {
  await mkdir(cfg.dataDir, { recursive: true });
  const dbPath = join(cfg.dataDir, "lobbyist.db");
  const db = new Database(dbPath, { create: true });
  // WAL is faster and safer for concurrent reads while a brief is being written.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const schema = await readFile(SCHEMA_PATH, "utf8");
  db.exec(schema);

  return new SqliteClient(db);
}
