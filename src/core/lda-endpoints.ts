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
 * List all filings for a given client_id (LD-1 + LD-2) across a year range.
 * Paginates automatically. Most clients have <100 filings across the 20+ year
 * history, so the default 20-page limit is plenty.
 */
export async function listFilingsForClient(
  client: LdaClient,
  opts: {
    clientId: number;
    yearStart?: number;
    yearEnd?: number;
    quarter?: 1 | 2 | 3 | 4;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<Filing[]> {
  const query: Record<string, string | number> = {
    client_id: opts.clientId,
    page_size: opts.pageSize ?? 50,
  };
  if (opts.yearStart !== undefined) query.filing_year_min = opts.yearStart;
  if (opts.yearEnd !== undefined) query.filing_year_max = opts.yearEnd;
  if (opts.quarter !== undefined) {
    query.filing_period = `${["first", "second", "third", "fourth"][opts.quarter - 1]}_quarter`;
  }
  return client.paginate("/filings/", query, FilingPageSchema, {
    maxPages: opts.maxPages ?? 20,
  });
}

/**
 * List filings where a given bill (or free-text issue) is the subject. LDA's
 * filings endpoint doesn't join on Congress.gov bill IDs; lobbyists cite bills
 * in the free-text `lobbying_activities.description` field. We use
 * `filing_specific_lobbying_issues` (substring match) as the best available
 * server-side filter, then skills do client-side narrowing.
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
  if (opts.yearStart !== undefined) query.filing_year_min = opts.yearStart;
  if (opts.yearEnd !== undefined) query.filing_year_max = opts.yearEnd;
  return client.paginate("/filings/", query, FilingPageSchema, {
    maxPages: opts.maxPages ?? 20,
  });
}

/**
 * List filings under a specific general issue code (e.g. "HCR" = Health).
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
  const query: Record<string, string | number> = {
    filing_general_issue_code: opts.issueCode,
    page_size: opts.pageSize ?? 50,
  };
  if (opts.yearStart !== undefined) query.filing_year_min = opts.yearStart;
  if (opts.yearEnd !== undefined) query.filing_year_max = opts.yearEnd;
  return client.paginate("/filings/", query, FilingPageSchema, {
    maxPages: opts.maxPages ?? 20,
  });
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
