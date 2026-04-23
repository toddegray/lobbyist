/**
 * Typed wrappers around the Senate LDA API endpoints that lobbyist uses.
 *
 * The LdaClient is deliberately dumb (GET + parse + cache). Endpoint-specific
 * semantics — which query params are safe, which fields to select, what shape
 * to expect — live here. Skills call these helpers rather than poking raw
 * paths.
 *
 * API reference: https://lda.senate.gov/api/redoc/v1/
 *
 * Note: the LDA API exposes a LOT of fields. We zod-parse only the subset the
 * v0.1 skills consume, with permissive `.passthrough()` on nested objects so
 * future fields don't break callers. As skills mature, we'll tighten.
 */

import { z } from "zod";
import type { LdaClient, LdaPage } from "./lda-client.ts";

// ---------------------------------------------------------------------------
// Common nested shapes
// ---------------------------------------------------------------------------

const RegistrantShortSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    description: z.string().nullable().optional(),
    address_1: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
  })
  .passthrough();

const ClientShortSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    general_description: z.string().nullable().optional(),
    client_government_entity: z.boolean().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
  })
  .passthrough();

const LobbyistShortSchema = z
  .object({
    id: z.number().int(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    suffix: z.string().nullable().optional(),
  })
  .passthrough();

/** Wraps a lobbyist with filing-specific fields (covered_position etc.). */
const LobbyistActivitySchema = z
  .object({
    lobbyist: LobbyistShortSchema,
    covered_position: z.string().nullable().optional(),
    new: z.boolean().nullable().optional(),
  })
  .passthrough();

const GovtEntitySchema = z
  .object({
    id: z.number().int().nullable().optional(),
    name: z.string(),
  })
  .passthrough();

const LobbyingActivitySchema = z
  .object({
    general_issue_code: z.string().nullable().optional(),
    general_issue_code_display: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    foreign_entity_issues: z.string().nullable().optional(),
    lobbyists: z.array(LobbyistActivitySchema).default([]),
    government_entities: z.array(GovtEntitySchema).default([]),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Filing (the heart of the API)
// ---------------------------------------------------------------------------

/**
 * Filing types:
 *   RR   Registration (LD-1)
 *   Q1/Q2/Q3/Q4         Quarterly report (LD-2)
 *   MM   Mid-year LD-203 contribution report
 *   YE   Year-end LD-203 contribution report
 *   (plus amendments appended with "A")
 */
export const FilingSchema = z
  .object({
    url: z.string().url(),
    filing_uuid: z.string(),
    filing_type: z.string(),
    filing_type_display: z.string().nullable().optional(),
    filing_year: z.number().int(),
    filing_period: z.string().nullable().optional(),
    filing_period_display: z.string().nullable().optional(),
    filing_document_url: z.string().url().nullable().optional(),
    income: z.string().nullable().optional(),              // LDA stores as string; cast at consumer
    expenses: z.string().nullable().optional(),
    expenses_method: z.string().nullable().optional(),
    expenses_method_display: z.string().nullable().optional(),
    posted_by_name: z.string().nullable().optional(),
    dt_posted: z.string().nullable().optional(),
    registrant: RegistrantShortSchema,
    client: ClientShortSchema,
    lobbying_activities: z.array(LobbyingActivitySchema).default([]),
    conviction_disclosures: z.array(z.unknown()).default([]),
    foreign_entities: z.array(z.unknown()).default([]),
    affiliated_organizations: z.array(z.unknown()).default([]),
  })
  .passthrough();

export type Filing = z.infer<typeof FilingSchema>;

// Page schemas: we let zod infer the type and cast to LdaPage<T> at use-sites
// rather than annotating here. The .passthrough() in the nested schemas
// produces an input-vs-output divergence that confuses the explicit
// z.ZodType<LdaPage<T>> annotation.
const FilingPageSchema = z.object({
  count: z.number().int(),
  next: z.string().url().nullable(),
  previous: z.string().url().nullable(),
  results: z.array(FilingSchema),
}) as unknown as z.ZodType<LdaPage<Filing>>;

// ---------------------------------------------------------------------------
// Registrant directory
// ---------------------------------------------------------------------------

export const RegistrantSchema = RegistrantShortSchema;
export type Registrant = z.infer<typeof RegistrantSchema>;

const RegistrantPageSchema = z.object({
  count: z.number().int(),
  next: z.string().url().nullable(),
  previous: z.string().url().nullable(),
  results: z.array(RegistrantSchema),
}) as unknown as z.ZodType<LdaPage<Registrant>>;

// ---------------------------------------------------------------------------
// Client directory
// ---------------------------------------------------------------------------

export const ClientSchema = ClientShortSchema;
export type Client = z.infer<typeof ClientSchema>;

const ClientPageSchema = z.object({
  count: z.number().int(),
  next: z.string().url().nullable(),
  previous: z.string().url().nullable(),
  results: z.array(ClientSchema),
}) as unknown as z.ZodType<LdaPage<Client>>;

// ---------------------------------------------------------------------------
// Endpoint wrappers
// ---------------------------------------------------------------------------

/**
 * Search clients by name. Useful for resolving "Pfizer" → a concrete client_id.
 * LDA's client endpoint supports `client_name` (substring match, case-insensitive).
 */
export async function searchClients(
  client: LdaClient,
  name: string,
  opts: { pageSize?: number } = {},
): Promise<Client[]> {
  const page = await client.get(
    "/clients/",
    { client_name: name, page_size: opts.pageSize ?? 25 },
    ClientPageSchema,
  );
  return page.results;
}

/**
 * Search registrants (lobbying firms) by name.
 */
export async function searchRegistrants(
  client: LdaClient,
  name: string,
  opts: { pageSize?: number } = {},
): Promise<Registrant[]> {
  const page = await client.get(
    "/registrants/",
    { registrant_name: name, page_size: opts.pageSize ?? 25 },
    RegistrantPageSchema,
  );
  return page.results;
}

/**
 * Internal helper. LDA's `filing_year` is an *exact-match* filter — there is
 * no native range support. For a year range we issue one paginated call per
 * year and concatenate.
 *
 * The browsable API at /filings/?format=api enumerates the real filter names
 * (`filing_year`, `filing_period`, `client_id`, `registrant_id`, `lobbyist_id`,
 * `filing_specific_lobbying_issues`, `filing_dt_posted_after`/`_before`, etc.).
 * Parameters not in that list are silently ignored.
 */
async function listFilingsRanged(
  client: LdaClient,
  baseQuery: Record<string, string | number>,
  opts: {
    yearStart?: number;
    yearEnd?: number;
    maxPagesPerYear?: number;
  } = {},
): Promise<Filing[]> {
  const maxPages = opts.maxPagesPerYear ?? 20;
  const results: Filing[] = [];
  if (opts.yearStart !== undefined && opts.yearEnd !== undefined) {
    for (let y = opts.yearStart; y <= opts.yearEnd; y++) {
      const batch = await client.paginate(
        "/filings/",
        { ...baseQuery, filing_year: y },
        FilingPageSchema,
        { maxPages },
      );
      results.push(...batch);
    }
  } else if (opts.yearStart !== undefined) {
    const batch = await client.paginate(
      "/filings/",
      { ...baseQuery, filing_year: opts.yearStart },
      FilingPageSchema,
      { maxPages },
    );
    results.push(...batch);
  } else {
    const batch = await client.paginate("/filings/", baseQuery, FilingPageSchema, { maxPages });
    results.push(...batch);
  }
  return results;
}

/**
 * List filings for a client across a year range.
 *
 * CRITICAL: LDA's `client_id` identifies a client-firm *relationship*, not
 * a company. Pfizer Inc has 87 distinct client_ids in LDA — one per firm
 * that has ever represented them. Querying by a single client_id misses
 * most of a company's filings.
 *
 * The correct query for "all of a company's filings" is `client_name`
 * (substring, case-insensitive). That's the default path here.
 *
 * Pass `clientId` only when you genuinely mean a specific relationship —
 * e.g. when you already resolved an exact LDA record and want just its
 * filings. If both are given, clientId wins.
 */
export async function listFilingsForClient(
  client: LdaClient,
  opts: {
    clientName?: string;
    clientId?: number;
    yearStart?: number;
    yearEnd?: number;
    quarter?: 1 | 2 | 3 | 4;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<Filing[]> {
  if (opts.clientName === undefined && opts.clientId === undefined) {
    throw new Error("listFilingsForClient requires either clientName or clientId");
  }
  const query: Record<string, string | number> = {
    page_size: opts.pageSize ?? 50,
  };
  if (opts.clientId !== undefined) {
    query.client_id = opts.clientId;
  } else if (opts.clientName !== undefined) {
    query.client_name = opts.clientName;
  }
  if (opts.quarter !== undefined) {
    query.filing_period = `${["first", "second", "third", "fourth"][opts.quarter - 1]}_quarter`;
  }
  return listFilingsRanged(client, query, {
    yearStart: opts.yearStart,
    yearEnd: opts.yearEnd,
    maxPagesPerYear: opts.maxPages ?? 20,
  });
}

/**
 * List filings where a given bill cite or issue keyword appears in the filer's
 * free-text specific-issue description. Substring-match on
 * `filing_specific_lobbying_issues` — the only server-side filter LDA exposes
 * that touches issue content.
 */
export async function listFilingsByIssueSubstring(
  client: LdaClient,
  opts: {
    issueSubstring: string;
    yearStart?: number;
    yearEnd?: number;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<Filing[]> {
  const query: Record<string, string | number> = {
    filing_specific_lobbying_issues: opts.issueSubstring,
    page_size: opts.pageSize ?? 50,
  };
  return listFilingsRanged(client, query, {
    yearStart: opts.yearStart,
    yearEnd: opts.yearEnd,
    maxPagesPerYear: opts.maxPages ?? 20,
  });
}

/**
 * Search individual lobbyists by name. The LDA lobbyist endpoint accepts
 * `lobbyist_name` (substring, case-insensitive).
 */
const LobbyistSearchSchema = z
  .object({
    id: z.number().int(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    suffix: z.string().nullable().optional(),
  })
  .passthrough();

const LobbyistSearchPage = z.object({
  count: z.number().int(),
  next: z.string().url().nullable(),
  previous: z.string().url().nullable(),
  results: z.array(LobbyistSearchSchema),
});

export type LobbyistSearchResult = z.infer<typeof LobbyistSearchSchema>;

export async function searchLobbyists(
  client: LdaClient,
  name: string,
  opts: { pageSize?: number } = {},
): Promise<LobbyistSearchResult[]> {
  const res = await client.get(
    "/lobbyists/",
    { lobbyist_name: name, page_size: opts.pageSize ?? 25 },
    LobbyistSearchPage,
  );
  return res.results;
}

/** List all filings in which a lobbyist (by LDA id) appears. */
export async function listFilingsForLobbyist(
  client: LdaClient,
  opts: {
    lobbyistId: number;
    yearStart?: number;
    yearEnd?: number;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<Filing[]> {
  return listFilingsRanged(
    client,
    {
      lobbyist_id: opts.lobbyistId,
      page_size: opts.pageSize ?? 50,
    },
    {
      yearStart: opts.yearStart,
      yearEnd: opts.yearEnd,
      maxPagesPerYear: opts.maxPages ?? 20,
    },
  );
}

/** List filings for a registrant (lobbying firm). */
export async function listFilingsForRegistrant(
  client: LdaClient,
  opts: {
    registrantId: number;
    yearStart?: number;
    yearEnd?: number;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<Filing[]> {
  return listFilingsRanged(
    client,
    {
      registrant_id: opts.registrantId,
      page_size: opts.pageSize ?? 50,
    },
    {
      yearStart: opts.yearStart,
      yearEnd: opts.yearEnd,
      maxPagesPerYear: opts.maxPages ?? 20,
    },
  );
}

/**
 * List filings matching a general issue code (e.g. "HCR" = Health).
 *
 * **Honest caveat:** LDA has no server-side filter on `general_issue_code`.
 * The only issue-content filter is `filing_specific_lobbying_issues`, which
 * substring-matches the free-text description field. We use it as the
 * server-side narrowing pass (it catches filings where the code string
 * happens to appear in the description), then we client-side filter the
 * results to keep only filings whose `lobbying_activities[].general_issue_code`
 * actually matches the requested code.
 *
 * This is NOT a guaranteed-complete scan — filings that don't literally
 * include the code in their description text will be missed. For broader
 * coverage, prefer `listFilingsByIssueSubstring` with a human-readable
 * keyword (e.g. "healthcare" instead of "HCR") or walk filings via
 * client / registrant / lobbyist filters.
 */
export async function listFilingsByIssueCode(
  client: LdaClient,
  opts: {
    issueCode: string;
    yearStart?: number;
    yearEnd?: number;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<Filing[]> {
  const code = opts.issueCode.toUpperCase();
  const raw = await listFilingsRanged(
    client,
    {
      filing_specific_lobbying_issues: code,
      page_size: opts.pageSize ?? 50,
    },
    {
      yearStart: opts.yearStart,
      yearEnd: opts.yearEnd,
      maxPagesPerYear: opts.maxPages ?? 20,
    },
  );
  return raw.filter((f) =>
    (f.lobbying_activities ?? []).some(
      (a) => (a.general_issue_code ?? "").toUpperCase() === code,
    ),
  );
}

// ---------------------------------------------------------------------------
// Amount parsing (LDA stores money as strings like "150000.00" or null)
// ---------------------------------------------------------------------------

/**
 * LD-2 filings report EITHER `income` (when the registrant is a lobbying firm
 * billing a client) OR `expenses` (when the client self-files and is reporting
 * their own in-house lobbying spend). Never both. This picks whichever is set.
 */
export function filingSpend(f: Filing): number | null {
  const raw = f.income ?? f.expenses ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Which quarter a filing covers, or null for non-quarterly filings.
 */
export function filingQuarter(f: Filing): 1 | 2 | 3 | 4 | null {
  const p = (f.filing_period || "").toLowerCase();
  if (p.startsWith("first")) return 1;
  if (p.startsWith("second")) return 2;
  if (p.startsWith("third")) return 3;
  if (p.startsWith("fourth")) return 4;
  return null;
}

/**
 * Build the LDA filing URL a human can open in a browser (filing document PDF,
 * if the LDA provides one; otherwise a fallback to the filings list).
 */
export function filingHumanUrl(f: Filing): string {
  return (
    f.filing_document_url ??
    `https://lda.senate.gov/filings/public/filing/${f.filing_uuid}/print/`
  );
}
