# lobbyist — Architecture

lobbyist is a local-first TypeScript/Bun tool that composes four public
federal data sources into senior-analyst-quality lobbying briefs. This
document explains the pieces and how they fit.

## High-level layout

```
┌───────────────────────────────────────────────────────────────────────┐
│                         interface surfaces                            │
│   CLI  •  MCP stdio server  •  ask orchestrator  •  watch digests     │
└───────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│                            10 skills                                  │
│  entity-profile   bill-watchers   spend-analysis   revolving-door     │
│  committee-influence   contract-trace   coalition-detect              │
│  filing-diff   anomaly-scan   brief (composer)                        │
└───────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│              core clients (with rate-limit + cache + retry)           │
│  LdaClient   OpenFecClient   UsaSpendingClient   CongressClient       │
└───────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│                 memory layer — one SQLite file                        │
│  entities  entity_aliases  filings  briefs  annotations  watchlist    │
│            (the alias graph is the compounding moat)                  │
└───────────────────────────────────────────────────────────────────────┘
```

## The four data sources

| Source | Purpose | Auth |
| ------ | ------- | ---- |
| **Senate LDA API** (`lda.senate.gov/api/v1/`, migrating to `lda.gov` 2026-06-30) | LD-1 registrations, LD-2 quarterly reports, LD-203 contributions. The spine. | `Authorization: Token <key>` |
| **OpenFEC** (`api.open.fec.gov/v1/`) | Campaign finance. Joined with LDA for `committee-influence`. | api.data.gov key |
| **USASpending.gov** (`api.usaspending.gov/api/v2/`) | Federal contract awards. Joined with LDA for `contract-trace`. | None (anon) |
| **Congress.gov** (`api.congress.gov/v3/`) | Bill metadata + member biographical info. | api.data.gov key (falls back to OpenFEC key) |

All four are free, all four are public, all four produce structured data.
No OpenSecrets dependency. No scraping.

## Skill contract

Every skill is a pure async function with the signature:

```ts
runX(clients, db, input: XInput): Promise<Brief<XData>>
```

- **`input`** — a typed object with the parameters the caller needs.
- **`Brief<XData>`** — a structured envelope containing `data`, `citations`,
  `markdown`, plus metadata (entity, window, timestamp).
- **No direct I/O outside the clients passed in.** Skills don't read env
  vars, don't open files, don't call `process.exit`. Testability falls out.

Skills are files, not directories. A skill is one TS file. If it gets too
big, break out helpers — don't multiply skills.

## The entity-resolution graph (the moat)

The most expensive hidden work is mapping `"Pfizer"`, `"Pfizer Inc"`,
`"PFIZER INC"`, `"Pfizer, Inc."` to the same canonical identity.

### How it works

1. **Normalization** (`normalizeEntityName` in `src/db/repos.ts`). Uppercase,
   strip punctuation, strip legal suffixes (INC/LLC/LLP/CORP/COMPANY/…).
2. **Alias table** (`entity_aliases`). Maps normalized forms to
   `entity_id`s. Every filing we fetch grows this table automatically —
   the client and registrant names in LD-1/LD-2 headers become aliases for
   the entity they describe.
3. **Lookup** (`lookupEntityByName`). Query by normalized form; confirmed
   aliases win over unconfirmed; ordered by most-recent-seen.
4. **Fuzzy fallback** (`src/core/fuzzy.ts`). When the API returns multiple
   candidate hits and none matches verbatim, Jaro–Winkler similarity on
   normalized names picks the best. Threshold 0.8 default.

The second query for the same concept is faster (cache hit) and more
accurate (the graph has grown).

## The memory schema

```sql
entities        (entity_id PK, kind, external_id, display, metadata, timestamps)
entity_aliases  (entity_id FK, raw, normalized, source, confirmed, UNIQUE (entity_id, normalized, source))
filings         (filing_uuid PK, client_id, registrant_id, income, expenses, raw_json, fetched_at)
briefs          (entity_id FK, skill, window_key, envelope_json, UNIQUE (entity_id, skill, window_key))
annotations     (entity_id FK, note, created_at)
watchlist       (entity_id PK, window_key)
```

Every skill upserts filings into the mirror and saves its brief. The second
call for `entity-profile "Pfizer"` after a cold `entity-profile "Pfizer"`:

- LDA API cache hit on the filings list (24h TTL) — no network call.
- DB has every filing already; `upsertFilingsBatch` is idempotent.
- Alias lookup is O(log n) — no API call.

## The four cross-references that nobody else combines

| Skill | Join |
| ----- | ---- |
| `committee-influence` | LDA (filings touching issue codes) × FEC (ScheduleA receipts from client-employer pool to member's principal committee) |
| `contract-trace` | LDA (lobbying spend) × USASpending (contract awards to same recipient) |
| `bill-watchers` (+ Congress.gov in v1.0) | LDA (filings citing the bill) × Congress.gov (bill metadata, sponsors, committees of jurisdiction) |
| `revolving-door` | LDA (lobbyist registrations + covered_position text) — the revolving door *itself*; v1.0 will add bioguide cross-ref |

## Guardrails baked into the architecture

- **Every claim cites a source.** `Brief.citations` is a first-class field;
  skills that emit a number without adding a citation fail type-level
  conventions.
- **Filed facts vs derived analysis are labeled.** `contract-trace`'s
  ratio is explicitly tagged as derived; anomaly flags are tagged as
  suggestions.
- **No intent, no motive, no quid-pro-quo.** The narrative renderers of
  every skill end with a disclaimer that co-occurrence ≠ causation.
- **No claims about unregistered lobbying.** The tool surfaces the
  disclosed world; the README and every narrative repeats this.
- **Local-first.** No phone-home. No telemetry. The user's data_dir +
  cache_dir stay on their machine.

## Interfaces

- **CLI** (`src/cli.ts`). One subcommand per skill + `init`, `config`,
  `ping`, `recall`, `annotate`, `watch`, `ask`, `mcp`.
- **MCP server** (`src/mcp/server.ts`). Same skill surface, wrapped as
  stdio MCP tools. Drops into Claude Desktop / Claude Code / Cursor.
- **ask orchestrator** (`src/agents/ask.ts`). Claude tool-use loop; picks
  skills and composes a narrative.
- **watch daemon** (`src/cli/watch.ts`). Re-runs entity-profile for every
  watchlist entry, diffs against the previous brief, writes a digest file.

## Rate limits

| Client | Default rps | Notes |
| ------ | ----------- | ----- |
| LdaClient | 1.0 | Authenticated tier: ~120/min per LDA docs. Default is conservative. |
| OpenFecClient | 0.8 | api.data.gov is 60/min = 1.0 rps with zero headroom; 0.8 leaves buffer. |
| UsaSpendingClient | 2.0 | No published limit; politeness. |
| CongressClient | 1.0 | api.data.gov shared with OpenFEC; stay under the combined cap. |

All clients serialize requests (no bursting) and back off on 429.

## Why Bun + SQLite

- **One file on disk** for memory. No server process. `~/.lobbyist/data/lobbyist.db`.
- **Statement cache is mandatory** in the DbClient — `bun:sqlite` interacts
  poorly with re-prepared statements in tight loops (manifests as "closed
  database" errors). The engine caches prepared statements by SQL text for
  the client lifetime.
- **WAL mode** is on by default. Fast concurrent reads while a brief is
  being written.
- **Forward-only migrations** in `src/db/schema.sql` — idempotent SQL that
  runs on every open.
