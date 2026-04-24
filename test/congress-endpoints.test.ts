/**
 * Tests for Congress.gov endpoint helpers. Schema-level tests that exercise
 * `getBill`, `getBillCommittees`, `getMember`, and the url/label helpers —
 * using a fake CongressClient that replays live response shapes captured
 * from the real API in April 2026.
 *
 * Rationale: this repo previously shipped fabricated Congress.gov schemas
 * (terms as {item: [...]}, required fields the API doesn't return). Those
 * bugs went undetected because no test exercised the schemas. These tests
 * pin the real response shape so the next drift shows up as a test
 * failure, not a production 422.
 */

import { describe, expect, test } from "bun:test";
import {
  billHumanUrl,
  getBill,
  getBillCommittees,
  getMember,
  memberHumanUrl,
  sponsorShortLabel,
} from "../src/core/congress-endpoints.ts";
import type { CongressClient } from "../src/core/congress-client.ts";

// ---------------------------------------------------------------------------
// Fake client that replays live Congress.gov response shapes
// ---------------------------------------------------------------------------

/**
 * Captured April 2026 from /bill/117/hr/4346 (CHIPS and Science Act).
 * Fields trimmed to what our schema consumes.
 */
const LIVE_BILL_4346 = {
  bill: {
    congress: 117,
    type: "HR",
    number: "4346",
    title: "CHIPS and Science Act",
    introducedDate: "2021-07-01",
    latestAction: {
      actionDate: "2022-08-09",
      text: "Became Public Law No: 117-167.",
    },
    sponsors: [
      {
        bioguideId: "R000577",
        district: 13,
        firstName: "TIM",
        fullName: "Rep. Ryan, Tim [D-OH-13]",
        isByRequest: "N",
        lastName: "RYAN",
        party: "D",
        state: "OH",
        url: "https://api.congress.gov/v3/member/R000577?format=json",
      },
    ],
    policyArea: { name: "Science, Technology, Communications" },
    originChamber: "House",
  },
};

/**
 * Captured April 2026 from /bill/117/hr/4346/committees.
 */
const LIVE_BILL_4346_COMMITTEES = {
  committees: [
    {
      chamber: "Senate",
      name: "Appropriations Committee",
      systemCode: "ssap00",
      type: "Standing",
      url: "https://api.congress.gov/v3/committee/senate/ssap00?format=json",
      activities: [
        { date: "2022-06-23T00:09:02Z", name: "Discharged From" },
        { date: "2021-07-29T21:55:17Z", name: "Referred To" },
      ],
    },
    {
      chamber: "House",
      name: "Science, Space, and Technology Committee",
      systemCode: "hsy00",
      type: "Standing",
      url: "https://api.congress.gov/v3/committee/house/hsy00?format=json",
      activities: [{ date: "2021-07-01T21:00:00Z", name: "Referred To" }],
    },
  ],
};

/**
 * Captured April 2026 from /member/S000033 (Sanders). `terms` is a LIST —
 * this was the specific fabrication that broke our original schema.
 */
const LIVE_MEMBER_SANDERS = {
  member: {
    bioguideId: "S000033",
    firstName: "Bernard",
    lastName: "Sanders",
    directOrderName: "Bernie Sanders",
    invertedOrderName: "Sanders, Bernie",
    state: "Vermont",
    currentMember: true,
    birthYear: "1941",
    partyHistory: [
      { partyAbbreviation: "I", partyName: "Independent", startYear: 1991 },
    ],
    terms: [
      { chamber: "Senate", congress: 118, startYear: 2023, party: "Independent" },
      { chamber: "Senate", congress: 117, startYear: 2021, party: "Independent" },
      { chamber: "House", congress: 103, startYear: 1993, party: "Independent" },
    ],
  },
};

class FakeCongress {
  // Record what was requested so tests can assert on query behavior.
  public calls: Array<{ path: string; query: unknown }> = [];

  async get<T>(path: string, query: unknown, _schema: unknown): Promise<T> {
    this.calls.push({ path, query });
    if (path === "/bill/117/hr/4346") return LIVE_BILL_4346 as T;
    if (path === "/bill/117/hr/4346/committees") return LIVE_BILL_4346_COMMITTEES as T;
    if (path === "/member/S000033") return LIVE_MEMBER_SANDERS as T;
    throw new Error(`FakeCongress: unexpected path ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getBill", () => {
  test("parses CHIPS Act response into typed Bill", async () => {
    const fake = new FakeCongress();
    const bill = await getBill(fake as unknown as CongressClient, {
      congress: 117,
      type: "HR",
      number: 4346,
    });
    expect(bill.congress).toBe(117);
    expect(bill.type).toBe("HR");
    expect(bill.number).toBe("4346");
    expect(bill.title).toBe("CHIPS and Science Act");
    expect(bill.sponsors.length).toBe(1);
    expect(bill.sponsors[0]?.bioguideId).toBe("R000577");
    expect(bill.sponsors[0]?.party).toBe("D");
    expect(bill.latestAction?.text).toContain("Public Law No: 117-167");
  });

  test("lowercases the type segment in the URL", async () => {
    const fake = new FakeCongress();
    await getBill(fake as unknown as CongressClient, {
      congress: 117,
      type: "HR",
      number: 4346,
    });
    expect(fake.calls[0]?.path).toBe("/bill/117/hr/4346");
  });
});

describe("getBillCommittees", () => {
  test("returns the two CHIPS Act committees of jurisdiction", async () => {
    const fake = new FakeCongress();
    const committees = await getBillCommittees(fake as unknown as CongressClient, {
      congress: 117,
      type: "HR",
      number: 4346,
    });
    expect(committees.length).toBe(2);
    const chambers = committees.map((c) => c.chamber).sort();
    expect(chambers).toEqual(["House", "Senate"]);
    const senateCmte = committees.find((c) => c.chamber === "Senate");
    expect(senateCmte?.systemCode).toBe("ssap00");
    expect(senateCmte?.activities.length).toBe(2);
  });
});

describe("getMember", () => {
  test("parses Sanders response — terms as a list, not {item: [...]}", async () => {
    const fake = new FakeCongress();
    const member = await getMember(fake as unknown as CongressClient, "S000033");
    expect(member.bioguideId).toBe("S000033");
    expect(Array.isArray(member.terms)).toBe(true);
    expect(member.terms.length).toBeGreaterThanOrEqual(3);
    expect(member.partyHistory.length).toBe(1);
    expect(member.partyHistory[0]?.partyName).toBe("Independent");
  });
});

describe("URL + label helpers", () => {
  test("billHumanUrl routes HR → house-bill, S → senate-bill", () => {
    expect(billHumanUrl(117, "HR", 4346)).toBe(
      "https://www.congress.gov/bill/117th-congress/house-bill/4346",
    );
    expect(billHumanUrl(118, "S", 1234)).toBe(
      "https://www.congress.gov/bill/118th-congress/senate-bill/1234",
    );
  });

  test("memberHumanUrl points at bioguide.congress.gov", () => {
    expect(memberHumanUrl("S000033")).toBe(
      "https://bioguide.congress.gov/search/bio/S000033",
    );
  });

  test("sponsorShortLabel compresses to Name (Party-State)", () => {
    expect(sponsorShortLabel({ lastName: "RYAN", party: "D", state: "OH" })).toBe(
      "RYAN (D-OH)",
    );
    expect(sponsorShortLabel({})).toBe("? (?-?)");
  });
});
