/**
 * Typed wrappers around the Congress.gov API endpoints lobbyist uses.
 *
 * API docs: https://api.congress.gov/
 *
 * Scope: bill metadata + committees of jurisdiction + member biographical
 * info. Verified against live responses (April 2026). We use `.passthrough()`
 * on most objects so we only schema fields the skills actually consume —
 * Congress.gov returns large envelopes with many fields we don't use.
 */

import { z } from "zod";
import type { CongressClient } from "./congress-client.ts";

// ---------------------------------------------------------------------------
// Bill
// ---------------------------------------------------------------------------

const SponsorSchema = z
  .object({
    bioguideId: z.string(),
    fullName: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    party: z.string().optional(),
    state: z.string().optional(),
    district: z.number().int().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const LatestActionSchema = z
  .object({
    actionDate: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

const BillSchema = z
  .object({
    congress: z.number().int(),
    type: z.string(),                     // "HR", "S", "HJRES", "SJRES", ...
    number: z.union([z.string(), z.number()]),   // live API returns string
    title: z.string().optional(),
    introducedDate: z.string().optional(),
    latestAction: LatestActionSchema.optional(),
    sponsors: z.array(SponsorSchema).default([]),
    policyArea: z
      .object({ name: z.string().optional() })
      .passthrough()
      .optional(),
    originChamber: z.string().optional(),
  })
  .passthrough();

export type Bill = z.infer<typeof BillSchema>;

const BillResponseSchema = z.object({
  bill: BillSchema,
}) as unknown as z.ZodType<{ bill: Bill }>;

/**
 * Fetch bill metadata. type is case-insensitive (we lowercase for the URL).
 */
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
// Bill committees (committees of jurisdiction)
// ---------------------------------------------------------------------------

const BillCommitteeActivitySchema = z
  .object({
    date: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const BillCommitteeSchema = z
  .object({
    chamber: z.string(),
    name: z.string(),
    systemCode: z.string(),
    type: z.string().optional(),
    url: z.string().optional(),
    activities: z.array(BillCommitteeActivitySchema).default([]),
  })
  .passthrough();

export type BillCommittee = z.infer<typeof BillCommitteeSchema>;

const BillCommitteesResponseSchema = z.object({
  committees: z.array(BillCommitteeSchema).default([]),
}) as unknown as z.ZodType<{ committees: BillCommittee[] }>;

/**
 * Committees of jurisdiction for a bill — the chambers + standing committees
 * the bill was referred to, with activity timestamps.
 */
export async function getBillCommittees(
  client: CongressClient,
  opts: { congress: number; type: string; number: string | number },
): Promise<BillCommittee[]> {
  const typeLower = opts.type.toLowerCase();
  const path = `/bill/${opts.congress}/${typeLower}/${opts.number}/committees`;
  const res = await client.get(path, {}, BillCommitteesResponseSchema);
  return res.committees;
}

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

const MemberTermSchema = z
  .object({
    chamber: z.string().optional(),
    congress: z.number().int().optional(),
    startYear: z.number().int().optional(),
    endYear: z.number().int().optional(),
    memberType: z.string().optional(),
    stateCode: z.string().optional(),
    stateName: z.string().optional(),
    party: z.string().optional(),
    partyName: z.string().optional(),
    district: z.number().int().optional(),
  })
  .passthrough();

const PartyHistoryEntrySchema = z
  .object({
    partyAbbreviation: z.string().optional(),
    partyName: z.string().optional(),
    startYear: z.number().int().optional(),
    endYear: z.number().int().optional(),
  })
  .passthrough();

const MemberSchema = z
  .object({
    bioguideId: z.string(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    directOrderName: z.string().optional(),
    invertedOrderName: z.string().optional(),
    state: z.string().optional(),
    currentMember: z.boolean().optional(),
    birthYear: z.union([z.string(), z.number()]).optional(),
    // Live API returns `terms` as a list, not an object with .item.
    terms: z.array(MemberTermSchema).default([]),
    partyHistory: z.array(PartyHistoryEntrySchema).default([]),
  })
  .passthrough();

export type Member = z.infer<typeof MemberSchema>;

const MemberResponseSchema = z.object({
  member: MemberSchema,
}) as unknown as z.ZodType<{ member: Member }>;

export async function getMember(client: CongressClient, bioguideId: string): Promise<Member> {
  const res = await client.get(`/member/${bioguideId}`, {}, MemberResponseSchema);
  return res.member;
}

// ---------------------------------------------------------------------------
// Committee (by chamber + system code)
// ---------------------------------------------------------------------------

const CommitteeSchema = z
  .object({
    systemCode: z.string(),
    name: z.string(),
    chamber: z.string(),
    type: z.string().optional(),
    parent: z
      .object({ systemCode: z.string(), name: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type Committee = z.infer<typeof CommitteeSchema>;

const CommitteeResponseSchema = z.object({
  committee: CommitteeSchema,
}) as unknown as z.ZodType<{ committee: Committee }>;

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
// Helpers: human-browsable URLs
// ---------------------------------------------------------------------------

export function billHumanUrl(congress: number, type: string, number: string | number): string {
  // congress.gov URLs use formats like "/bill/117th-congress/house-bill/4346"
  const chamberSlug =
    type.toUpperCase().startsWith("H") ? "house-bill" : "senate-bill";
  return `https://www.congress.gov/bill/${congress}th-congress/${chamberSlug}/${number}`;
}

export function memberHumanUrl(bioguideId: string): string {
  return `https://bioguide.congress.gov/search/bio/${encodeURIComponent(bioguideId)}`;
}

/**
 * Short human-readable sponsor line.
 *   "Rep. Ryan, Tim [D-OH-13]"  →  "Ryan (D-OH)"
 */
export function sponsorShortLabel(s: { lastName?: string; party?: string; state?: string }): string {
  const last = s.lastName ?? "?";
  const party = s.party ?? "?";
  const state = s.state ?? "?";
  return `${last} (${party}-${state})`;
}
