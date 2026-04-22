-- lobbyist database schema.
--
-- Forward-only migrations. Every statement is idempotent. The engine runs
-- this file on open; new tables append, existing tables are never dropped.
--
-- Design rules:
--   * entities are kind-polymorphic: registrant, client, lobbyist, member,
--     committee, bill, issue, contract, coalition.
--   * briefs are the durable record of every skill run; (entity_id, skill,
--     window_key) is the natural key. A re-run overwrites the previous brief.
--   * filings are mirrored from the LDA API so follow-up queries don't re-hit
--     the API on every run. filing_uuid is the primary key.
--   * entity_aliases is the resolution graph: many name-variants point at one
--     canonical entity_id. "Pfizer Inc" / "PFIZER INC" / "Pfizer, Inc." all
--     land on the same entity_id. This is the moat.
--   * annotations carry user notes per entity into future briefs.
--   * watchlist is a flat list of entity_ids plus the window we care about.
--
-- Amounts are stored as REAL (USD dollars). The LDA reports money to the
-- nearest $10K; USASpending reports exact. We don't mix them in one column.

CREATE TABLE IF NOT EXISTS entities (
  entity_id    TEXT PRIMARY KEY,       -- "{kind}:{id}", e.g. "client:12345"
  kind         TEXT NOT NULL CHECK (kind IN (
                 'registrant','client','lobbyist','member','committee',
                 'bill','issue','contract','coalition'
               )),
  external_id  TEXT,                   -- LDA id, bioguide id, USASpending key, etc.
  display      TEXT NOT NULL,
  metadata     TEXT,                   -- JSON blob (state, description, party, chamber, ...)
  first_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_kind        ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_external_id ON entities(external_id) WHERE external_id IS NOT NULL;

-- Entity aliases: the resolution graph. Many normalized names → one entity.
-- `normalized` is the uppercase, punctuation-stripped, legal-suffix-collapsed
-- form of the display name. Skills do a lookup against this table before
-- falling back to a live API search, so the second query for the same
-- name-variant is free.
CREATE TABLE IF NOT EXISTS entity_aliases (
  alias_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   TEXT NOT NULL REFERENCES entities(entity_id),
  raw         TEXT NOT NULL,           -- the name as encountered in a filing / query
  normalized  TEXT NOT NULL,           -- normalize(raw) — uppercase, no punctuation
  source      TEXT,                    -- 'lda' | 'fec' | 'usaspending' | 'user'
  confirmed   INTEGER NOT NULL DEFAULT 0,  -- 1 = human-confirmed, 0 = inferred
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(entity_id, normalized, source)
);

CREATE INDEX IF NOT EXISTS idx_aliases_normalized ON entity_aliases(normalized);
CREATE INDEX IF NOT EXISTS idx_aliases_entity     ON entity_aliases(entity_id);

-- Filings: the durable mirror of LDA filings we've seen. Keeping these lets
-- every skill compose across the same shared fact base, and lets us diff an
-- entity across quarters without re-hitting the API.
CREATE TABLE IF NOT EXISTS filings (
  filing_uuid     TEXT PRIMARY KEY,
  filing_type     TEXT NOT NULL,       -- 'RR', 'Q1', 'Q2', 'Q3', 'Q4', 'MM', 'YE' (+ 'A' for amendments)
  filing_year     INTEGER NOT NULL,
  filing_period   TEXT,                -- 'first_quarter', 'mid_year', ...
  registrant_id   INTEGER,              -- LDA registrant.id
  registrant_name TEXT,
  client_id       INTEGER,              -- LDA client.id
  client_name     TEXT,
  income          REAL,                 -- NULL for expense-type filings
  expenses        REAL,                 -- NULL for income-type filings
  posted_at       TEXT,                 -- LDA dt_posted
  document_url    TEXT,                 -- LDA filing_document_url
  raw_json        TEXT NOT NULL,        -- full filing payload as captured
  fetched_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_filings_client    ON filings(client_id, filing_year);
CREATE INDEX IF NOT EXISTS idx_filings_registrant ON filings(registrant_id, filing_year);
CREATE INDEX IF NOT EXISTS idx_filings_year       ON filings(filing_year);

-- Briefs: one row per (entity, skill, window_key). Storing the full envelope
-- as JSON keeps the schema stable across skill iterations while still letting
-- us index on the key dimensions.
CREATE TABLE IF NOT EXISTS briefs (
  brief_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id      TEXT NOT NULL REFERENCES entities(entity_id),
  skill          TEXT NOT NULL,
  window_key     TEXT NOT NULL,        -- from windowKey(brief.window), e.g. "2020-2024-all"
  year_start     INTEGER NOT NULL,
  year_end       INTEGER NOT NULL,
  quarter        INTEGER,              -- 1..4 or NULL
  generated_at   TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  envelope_json  TEXT NOT NULL,        -- full Brief<TData> as JSON
  markdown       TEXT NOT NULL,
  UNIQUE (entity_id, skill, window_key)
);

CREATE INDEX IF NOT EXISTS idx_briefs_entity      ON briefs(entity_id);
CREATE INDEX IF NOT EXISTS idx_briefs_skill       ON briefs(skill, year_start, year_end);

-- Annotations: free-text user notes per entity. Carried into future briefs
-- by the skill that composes narrative output.
CREATE TABLE IF NOT EXISTS annotations (
  annotation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     TEXT NOT NULL REFERENCES entities(entity_id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_entity ON annotations(entity_id, created_at);

-- Watchlist: entities flagged for scheduled re-runs and diff detection.
CREATE TABLE IF NOT EXISTS watchlist (
  entity_id   TEXT PRIMARY KEY REFERENCES entities(entity_id),
  window_key  TEXT NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
