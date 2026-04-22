/**
 * Typed wrappers around the Congress.gov API endpoints lobbyist uses.
 *
 * API docs: https://api.congress.gov/
 *
 * Scope at v0.5: bill metadata lookup and member → committee lookup. We
 * deliberately do NOT try to wrap the full Congress.gov surface — it's huge
 * and most of it is orthogonal to the money-in-politics thesis.
 */

import { z } from "zod";
import type { CongressClient } from "./congress-client.ts";

// ---------------------------------------------------------------------------
// Bill
// ---------------------------------------------------------------------------

const BillSchema = z
  .object({
    congress: z.number().int(),
    type: z.string(),           // "HR", "S", "HJRES", "SJRES", ...
    number: z.number().int().or(z.string()),
    title: z.string().nullable().optional(),
    introducedDate: z.string().nullable().optional(),
    latestAction: z
      .object({
        actionDate: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    sponsors: z
      .array(
        z
          .object({
            bioguideId: z.string().nullable().optional(),
            fullName: z.string().nullable().optional(),
            party: z.string().nullable().optional(),
            state: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type Bill = z.infer<typeof BillSchema>;

const BillResponseSchema = z.object({
  bill: BillSchema,
}) as unknown as z.ZodType<{ bill: Bill }>;

export async function getBill(
  client: CongressClient,
  opts: { congress: number; type: string; number: string | number },
): Promise<Bill> {
  const typeLower = opts.type.toLowerCase();
  const path = `/bill/${opts.congress}/${typeLower}/${opts.number}`;
  const res = await client.get(path, {}, BillResponseSchema);
  return res.bill;
}

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

const MemberSchema = z
  .object({
    bioguideId: z.string(),
    directOrderName: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    partyName: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    terms: z
      .object({
        item: z.array(
          z
            .object({
              chamber: z.string().nullable().optional(),
              congress: z.number().int().nullable().optional(),
              startYear: z.number().int().nullable().optional(),
              endYear: z.number().int().nullable().optional(),
            })
            .passthrough(),
        ),
      })
      .partial()
      .nullable()
      .optional(),
  })
  .passthrough();

export type Member = z.infer<typeof MemberSchema>;

const MemberResponseSchema = z.object({ member: MemberSchema });

export async function getMember(client: CongressClient, bioguideId: string): Promise<Member> {
  const res = await client.get(`/member/${bioguideId}`, {}, MemberResponseSchema);
  return res.member;
}

// ---------------------------------------------------------------------------
// Committee
// ---------------------------------------------------------------------------

const CommitteeSchema = z
  .object({
    systemCode: z.string(),
    name: z.string(),
    chamber: z.string(),
    type: z.string().nullable().optional(),
    parentCommittee: z
      .object({ systemCode: z.string(), name: z.string() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type Committee = z.infer<typeof CommitteeSchema>;

const CommitteeResponseSchema = z.object({ committee: CommitteeSchema });

export async function getCommittee(
  client: CongressClient,
  chamber: "house" | "senate",
  systemCode: string,
): Promise<Committee> {
  const res = await client.get(
    `/committee/${chamber}/${systemCode}`,
    {},
    CommitteeResponseSchema,
  );
  return res.committee;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function billHumanUrl(congress: number, type: string, num: string | number): string {
  const slug = `${type.toLowerCase()}${num}`;
  return `https://www.congress.gov/bill/${congress}th-congress/${slug.replace(/\d+/, "/" + num)}`;
}

export function memberHumanUrl(bioguideId: string): string {
  return `https://bioguide.congress.gov/search/bio/${encodeURIComponent(bioguideId)}`;
}
