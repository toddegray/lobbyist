/**
 * Typed wrappers around the USASpending.gov endpoints lobbyist uses.
 *
 * Primary endpoint: POST /api/v2/search/spending_by_award/
 *   Request body:
 *     {
 *       "filters": {
 *         "recipient_search_text": ["Pfizer"],
 *         "time_period": [{"start_date": "2020-01-01", "end_date": "2024-12-31"}],
 *         "award_type_codes": ["A","B","C","D"]      // contracts
 *       },
 *       "fields": ["Award ID","Recipient Name","Award Amount", ...],
 *       "limit": 100,
 *       "page": 1
 *     }
 *
 * award_type_codes reference:
 *   A = BPA Call; B = Purchase Order; C = Delivery Order; D = Definitive Contract
 *   02 = Block Grant; 03 = Formula Grant; 04 = Project Grant; 05 = Cooperative Agreement
 *   06 = Direct Payment (specified use); 10 = Direct Payment (unrestricted)
 *   07/08 = Direct Loan / Guaranteed Loan; 09 = Insurance; 11 = Other Financial Assistance
 *   IDV_A..IDV_E = Indefinite Delivery Vehicles
 *
 * The API paginates. Default page size is 100; max is 100.
 */

import { z } from "zod";
import type { UsaSpendingClient } from "./usaspending-client.ts";

/** Standard contract award-type code set (excludes IDVs, loans, grants). */
export const CONTRACT_AWARD_TYPE_CODES = ["A", "B", "C", "D"] as const;

// ---------------------------------------------------------------------------
// Response schema (defensive: passthrough on rows)
// ---------------------------------------------------------------------------

const AwardRowSchema = z
  .object({
    "Award ID": z.string().nullable().optional(),
    generated_internal_id: z.string().nullable().optional(),
    "Recipient Name": z.string().nullable().optional(),
    "Award Amount": z.number().nullable().optional(),
    "Awarding Agency": z.string().nullable().optional(),
    "Awarding Sub Agency": z.string().nullable().optional(),
    "Start Date": z.string().nullable().optional(),
    "End Date": z.string().nullable().optional(),
    "Description": z.string().nullable().optional(),
    "Contract Award Type": z.string().nullable().optional(),
  })
  .passthrough();

export type AwardRow = z.infer<typeof AwardRowSchema>;

const SearchAwardResponseSchema = z.object({
  limit: z.number().int(),
  page_metadata: z
    .object({
      page: z.number().int(),
      hasNext: z.boolean(),
      hasPrevious: z.boolean(),
      next: z.number().nullable().optional(),
      previous: z.number().nullable().optional(),
    })
    .passthrough(),
  results: z.array(AwardRowSchema),
});

// ---------------------------------------------------------------------------
// Endpoint wrapper
// ---------------------------------------------------------------------------

export interface SearchAwardsOptions {
  /** Recipient search substring(s). USASpending uses AND across values. */
  recipient: string;
  yearStart: number;
  yearEnd: number;
  /**
   * Which award types to include. Defaults to contracts (A/B/C/D). Pass
   * explicit codes to include grants, IDVs, etc.
   */
  awardTypeCodes?: readonly string[];
  /** Page size (max 100). */
  pageSize?: number;
  /** Max pages to walk. Default 10 (1000 awards). */
  maxPages?: number;
}

export async function searchContractAwards(
  client: UsaSpendingClient,
  opts: SearchAwardsOptions,
): Promise<AwardRow[]> {
  const pageSize = Math.min(opts.pageSize ?? 100, 100);
  const maxPages = opts.maxPages ?? 10;
  const results: AwardRow[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const body = {
      filters: {
        recipient_search_text: [opts.recipient],
        time_period: [
          {
            start_date: `${opts.yearStart}-01-01`,
            end_date: `${opts.yearEnd}-12-31`,
          },
        ],
        award_type_codes: [...(opts.awardTypeCodes ?? CONTRACT_AWARD_TYPE_CODES)],
      },
      fields: [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Awarding Agency",
        "Awarding Sub Agency",
        "Start Date",
        "End Date",
        "Description",
        "Contract Award Type",
      ],
      limit: pageSize,
      page,
      sort: "Award Amount",
      order: "desc",
    };
    const res = await client.post("/search/spending_by_award/", body, SearchAwardResponseSchema);
    results.push(...res.results);
    if (!res.page_metadata.hasNext) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a usaspending.gov human-browsable URL from an award's
 * `generated_internal_id`. The `generated_internal_id` is the stable key
 * USASpending uses across its API + frontend.
 */
export function awardHumanUrl(row: AwardRow): string {
  const gid = row.generated_internal_id;
  if (gid) return `https://www.usaspending.gov/award/${encodeURIComponent(gid)}`;
  return "https://www.usaspending.gov/";
}

export function awardAmount(row: AwardRow): number {
  return typeof row["Award Amount"] === "number" ? row["Award Amount"]! : 0;
}

export function awardYear(row: AwardRow): number | null {
  const s = row["Start Date"] ?? row["End Date"];
  if (!s) return null;
  const y = Number.parseInt(s.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}
