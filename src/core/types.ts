/**
 * Shared domain types for lobbyist.
 *
 * Every skill produces a Brief: a structured envelope containing the typed
 * data it computed plus the citations that back every number. The markdown
 * the skill renders is a view over the envelope — the envelope is the
 * contract, the markdown is derivative.
 *
 * Rule: no number, lobbyist name, bill number, or contract amount appears in
 * narrative output without a Citation. Hallucinated figures are unshippable;
 * see CLAUDE.md rule #2.
 */

// ---------------------------------------------------------------------------
// Entity identity
// ---------------------------------------------------------------------------

/**
 * The universe of things lobbyist tracks. Deliberately broader than fec-analyst
 * because we join across LDA, FEC, USASpending, Congress.gov, and bioguide.
 *
 *  - `registrant`        A lobbying firm registered to lobby on behalf of clients (LDA registrant)
 *  - `client`            An entity hiring lobbyists (often a company, trade association, union, gov't entity)
 *  - `lobbyist`          An individual registered lobbyist (a person)
 *  - `member`            A sitting member of Congress
 *  - `committee`         A congressional committee (or subcommittee)
 *  - `bill`              A piece of legislation (bill_id format: "{congress}-{chamber}-{number}", e.g. "118-HR-5376")
 *  - `issue`             An LDA general issue code (e.g. "HCR" = Health issues, "TAX" = Taxation)
 *  - `contract`          A federal contract award (USASpending award_id)
 *  - `coalition`         A detected group of entities lobbying together (derived)
 */
export type EntityKind =
  | "registrant"
  | "client"
  | "lobbyist"
  | "member"
  | "committee"
  | "bill"
  | "issue"
  | "contract"
  | "coalition";

export interface EntityId {
  kind: EntityKind;
  /**
   * Stable identifier for the entity.
   *   - registrant / client:   LDA registrant_id or client_id (integer from the LDA API)
   *   - lobbyist:              LDA lobbyist_id, or a synthesized hash if none is available
   *   - member:                bioguide ID (e.g. "T000464" for Tester)
   *   - committee:             Congress.gov system code (e.g. "ssaf00" for Senate Agriculture)
   *   - bill:                  "{congress}-{chamber}-{number}" (e.g. "118-HR-5376")
   *   - issue:                 LDA general issue code (e.g. "HCR")
   *   - contract:              USASpending unique_award_key
   *   - coalition:             synthesized hash of member entity_ids, sorted
   */
  id: string;
  /** Human-readable display name. */
  display: string;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** Which public data source backs a given citation. */
export type CitationSource = "lda" | "fec" | "usaspending" | "congress" | "bioguide" | "house_lda";

export interface Citation {
  /**
   * A short stable key the narrative can reference, e.g. "q3_spend" or
   * "top_lobbyist". Rendered as a bracketed marker in the markdown.
   */
  key: string;
  /** Human description of what this citation points at. */
  description: string;
  /** The data source this citation comes from. */
  source: CitationSource;
  /**
   * URL to the underlying record (LDA filing page, fec.gov report,
   * usaspending.gov award page, congress.gov bill page). Every claim needs one.
   */
  url: string;
  /**
   * The opaque identifier within the source system (LDA filing_uuid, FEC
   * filing_id, USASpending unique_award_key, Congress.gov bill slug).
   */
  source_id?: string;
  /** Optional exact quoted text from the filing. */
  quote?: string;
  /**
   * UTC ISO timestamp of when we fetched this record. Load-bearing: LDA
   * filings are frequently amended; the timestamp lets a reader know how
   * stale the claim is.
   */
  fetched_at?: string;
}

// ---------------------------------------------------------------------------
// Brief envelope
// ---------------------------------------------------------------------------

/**
 * A lobbyist Brief. Unlike fec-analyst's Brief (which is keyed on election
 * cycle), lobbyist briefs are keyed on a time window (year range or specific
 * quarter) because lobbying is quarterly, not biennial.
 */
export interface Brief<TData> {
  /** The skill that produced this brief. */
  skill: string;
  /** Schema version for the data payload. Bumped on breaking changes. */
  schema_version: number;
  /** The entity the brief is about. */
  entity: EntityId;
  /** Time window the brief covers. */
  window: TimeWindow;
  /** UTC ISO timestamp when the brief was generated. */
  generated_at: string;
  /** Structured typed data — skill-specific. */
  data: TData;
  /** Every claim cited here, keyed by the marker used in the narrative. */
  citations: Citation[];
  /** Rendered markdown view of `data`. */
  markdown: string;
}

/**
 * A time window the brief covers. Lobbying disclosure is quarterly, so most
 * briefs will span a set of (year, quarter) pairs.
 */
export interface TimeWindow {
  /** Inclusive start year (e.g. 2020). */
  year_start: number;
  /** Inclusive end year (e.g. 2024). */
  year_end: number;
  /**
   * Optional quarter filter. If set, only this quarter across each year in
   * range is included. Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec.
   * Omitted = all four quarters.
   */
  quarter?: 1 | 2 | 3 | 4;
}

export function windowKey(w: TimeWindow): string {
  const q = w.quarter ? `Q${w.quarter}` : "all";
  return `${w.year_start}-${w.year_end}-${q}`;
}

// ---------------------------------------------------------------------------
// Money helpers — LDA amounts are USD dollars, reported to the nearest $10K
// under the safe-harbor rules. USASpending amounts are reported exactly.
// Always format through fmtUsd so output is consistent.
// ---------------------------------------------------------------------------

export function fmtUsd(amount: number, opts: { decimals?: 0 | 2 } = {}): string {
  const decimals = opts.decimals ?? 0;
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function fmtPct(ratio: number, decimals = 1): string {
  return `${(ratio * 100).toFixed(decimals)}%`;
}
