# lobbyist

**An AI teammate for the senior lobbying analyst.** Point it at a company, get
the full profile — every registration, every quarterly filing, every lobbyist
employed, every issue lobbied, every committee contacted. Point it at a bill,
get the roster of every registered lobbyist working it. Point it at a firm,
cross-reference their lobbying spend with their federal contract wins.

MIT licensed. TypeScript on [Bun](https://bun.sh). **Runs fully local by
default.** Built on 25+ years of public Senate LDA filings, FEC campaign
contributions, and USASpending.gov federal contracts.

> **OpenSecrets killed their API in April 2025.** OpenLobby is a single
> independent website, not a tool. Lex Machina-scale incumbents don't exist
> here. This is the open-source toolkit we deserve.

---

> ⚠️  lobbyist reports **what filers themselves reported to the government**.
> It cannot detect unregistered lobbying, shadow lobbying, or off-the-books
> influence. It does not infer intent, motive, or quid-pro-quo. Every output
> is a **draft for a human analyst to review**. Shipped AS-IS under the MIT
> license with no warranty (see [LICENSE](LICENSE)).

---

## Install

```bash
git clone https://github.com/toddegray/lobbyist
cd lobbyist
bun install
bun run src/cli.ts init      # interactive; writes ~/.lobbyist/config.json
```

Requires [Bun 1.1+](https://bun.sh/docs/installation). That's it — no Docker,
no database server, no cloud account. The whole thing is one SQLite file at
`~/.lobbyist/data/lobbyist.db`.

You'll need a Senate LDA API key (free, instant) from
<https://lda.senate.gov/api/register/>. An OpenFEC key (free, instant) from
<https://api.open.fec.gov/developers/> is optional at v0.1 but required for
the LDA + FEC cross-reference skills in v0.5.

To compile a standalone executable: `bun run build` → `./bin/lobbyist`.

## Thirty seconds in

```bash
# Profile a company (registrations, quarterly activity, lobbyists, issues, spend)
bun run src/cli.ts entity-profile "Pfizer Inc"

# Who's lobbying a bill?
bun run src/cli.ts bill-watchers --congress=118 --bill=HR5376

# Spend trend for an entity or issue area
bun run src/cli.ts spend-analysis "Pfizer Inc" --years=2020-2024

# Sanity-check your LDA key
bun run src/cli.ts ping
```

## What it does (v0.1)

Three hero skills. The full v1.0 roster is below.

| Skill | What it does |
| --- | --- |
| [`entity-profile`](src/skills/entity-profile.ts) | Full lobbying profile for a company, trade association, or law firm: registrations, quarterly activity, lobbyists employed, issues lobbied, committees contacted, spend trend. |
| [`bill-watchers`](src/skills/bill-watchers.ts) | Given a bill number or issue code, produces the list of every registered lobbyist working it, their clients, their spend, recent activity. |
| [`spend-analysis`](src/skills/spend-analysis.ts) | Spend trends, top spenders, quarter-over-quarter changes, and anomaly flags for an entity or issue area. |

### Coming in v0.5 / v1.0

`revolving-door`, `committee-influence` (LDA + FEC join),
`contract-trace` (LDA + USASpending join), `coalition-detect`, `filing-diff`,
`anomaly-scan`, `brief` composer, entity-resolution polish, watchlist +
alerts, web UI.

## The four cross-references that nobody else combines

1. **LDA + FEC** — this lobbying firm also gave $X to members of the committees of jurisdiction.
2. **LDA + USASpending** — this company spent $X lobbying and received $Y in federal contracts in the same period.
3. **LDA + Congress.gov** — this bill has N registered lobbyists working it, here's the breakdown by position.
4. **LDA + revolving-door** — this firm hired ex-staffer X three months after they left the office of Senator Y, who chairs the committee they're lobbying.

No dashboard asks natural-language questions across all four. No existing AI
tool has entity resolution deep enough to make these joins reliable. This is
the reason an agent is the right tool for the job.

## Architecture

```
src/
  core/         Domain types, LDA client, OpenFEC client, config
  db/           Engine (bun:sqlite), schema, repos
  skills/       Skill implementations (one per capability)
  cli/          CLI commands
  mcp/          MCP server (stdio)
  cli.ts        CLI entry
```

- **Memory:** one SQLite file, forward-only migrations, per-entity briefs
  persisted on every skill run so the second query is cheaper than the first.
- **Entity resolution:** the expensive, compounding asset. Normalized forms +
  fuzzy matching + human-in-the-loop confirmation, stored in memory. Every
  user's corrections feed back into their local graph.
- **Data sources (all free, all public):** Senate LDA API, Senate Office of
  Public Records bulk XML, House Clerk Lobbying Disclosure, FEC OpenFEC,
  USASpending.gov, Congress.gov, bioguide.congress.gov.

## Privacy

All public data. No PHI, no PII beyond what filers publish on government
websites. No phone-home telemetry. Cloud inference (Anthropic) is opt-in and
only used for narrative synthesis — never for the numbers.

## Guardrails

- Every claim links to the source filing (Senate LDA filing ID, FEC filing ID,
  USASpending award ID).
- No inference of intent or motive. The tool reports what was filed, never
  speculates about what was "really" happening.
- Clear distinction between filed facts (spend totals) and derived analysis
  (ROI calculations, coalition detection).
- Anomaly flags are suggestions, not accusations.
- No claims about unregistered lobbying.
- Timestamps on everything because filings are frequently amended.

## License

MIT. See [LICENSE](LICENSE).
