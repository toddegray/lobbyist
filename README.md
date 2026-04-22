# lobbyist

**An AI teammate for the senior lobbying analyst.** Follow the money from
the K Street office to the committee vote to the federal contract.

Point it at a company, get the full profile. Point it at a bill, get the
roster of every registered lobbyist working it. Point it at a member of
Congress, cross-reference the lobbying clients on their committee's
jurisdiction against the campaign contributions they received. Point it
at a firm, cross-reference their lobbying spend with their federal
contract wins.

MIT licensed. TypeScript on [Bun](https://bun.sh). **Runs fully local by
default.** Built on 25+ years of public Senate LDA filings, FEC campaign
contributions, USASpending.gov federal contract awards, and Congress.gov
bill metadata.

> **OpenSecrets killed their API in April 2025.** OpenLobby is a single
> independent website, not a tool. Lex Machina-scale incumbents don't
> exist here. This is the open-source toolkit we deserve.

---

> ⚠️  lobbyist reports **what filers themselves reported to the government**.
> It cannot detect unregistered lobbying, shadow lobbying, or off-the-books
> influence. It does not infer intent, motive, or quid-pro-quo. Every
> output is a **draft for a human analyst to review**. Shipped AS-IS under
> the MIT license with no warranty (see [LICENSE](LICENSE)).

---

## Install

```bash
git clone https://github.com/toddegray/lobbyist
cd lobbyist
bun install
bun run src/cli.ts init      # interactive; writes ~/.lobbyist/config.json
bun run src/cli.ts ping      # sanity-check your LDA key
```

Requires [Bun 1.1+](https://bun.sh/docs/installation). That's it — no
Docker, no database server, no cloud account. The whole thing is one
SQLite file at `~/.lobbyist/data/lobbyist.db`.

**Keys you'll need:**

- Senate LDA token (free, instant) from <https://lda.senate.gov/api/register/>
- **Optional:** OpenFEC key from <https://api.open.fec.gov/developers/> —
  unlocks `committee-influence` (LDA+FEC) and serves as the fallback for
  Congress.gov. One api.data.gov key works for both.
- **Optional:** Anthropic API key — unlocks the `ask` natural-language
  orchestrator.

To compile a standalone executable: `bun run build` → `./bin/lobbyist`.

## Thirty seconds in

```bash
# Profile a company — the single-call way
bun run src/cli.ts entity-profile "Pfizer Inc"

# Who's lobbying on a bill?
bun run src/cli.ts bill-watchers --bill="Kids Online Safety Act"

# Quarter-over-quarter spend with anomaly flags
bun run src/cli.ts spend-analysis "Amazon.com Services LLC"

# Revolving door — career arc of an individual lobbyist
bun run src/cli.ts revolving-door "Heather Podesta"

# LDA + FEC join — requires OpenFEC key
bun run src/cli.ts committee-influence --member="Bernie Sanders" \
    --issue-codes=HCR,MMM --cycle=2024

# LDA + USASpending join — lobbying spend vs federal contract awards
bun run src/cli.ts contract-trace "Lockheed Martin" --year-start=2020 --year-end=2024

# Coalitions — who lobbies together?
bun run src/cli.ts coalition-detect --bill="CHIPS Act" --year-start=2021 --year-end=2023

# Diff two quarters for the same client
bun run src/cli.ts filing-diff "Amazon.com Services LLC" --from=2020 --to=2024

# Pattern scan: late filings, ex-staffer hires, issue churn
bun run src/cli.ts anomaly-scan "Exxon Mobil Corporation"

# Full composed brief (all of the above, concatenated)
bun run src/cli.ts brief "JPMorgan Chase & Co." --with-contracts

# Natural language — Claude picks the right tools
bun run src/cli.ts ask "Which drug-pricing clients gave most to Senate Finance members in 2024?"
```

Every recipe is committed under [`examples/`](examples/).

## The skills (v0.5)

| Skill | What it does |
| ----- | ------------ |
| [`entity-profile`](src/skills/entity-profile.ts) | Full profile for a client: registrations, quarterly activity, lobbyists, issues, committees contacted, spend trend. |
| [`bill-watchers`](src/skills/bill-watchers.ts) | Every registered client lobbying on a bill or issue code, ranked by spend. |
| [`spend-analysis`](src/skills/spend-analysis.ts) | Quarter-over-quarter spend series with YoY deltas and anomaly flags. |
| [`revolving-door`](src/skills/revolving-door.ts) | Career arc for an individual lobbyist: covered positions, clients, firms. |
| [`committee-influence`](src/skills/committee-influence.ts) | **LDA + FEC join.** Lobbying clients on issues of a member's jurisdiction × FEC contributions to that member's campaign. |
| [`contract-trace`](src/skills/contract-trace.ts) | **LDA + USASpending join.** Lobbying spend vs. federal contract awards in the same period. |
| [`coalition-detect`](src/skills/coalition-detect.ts) | Clients lobbying together via shared firm / shared quarters / shared issues. |
| [`filing-diff`](src/skills/filing-diff.ts) | Diff a client's filings between two windows. Added/dropped lobbyists, issues, firms, govt entities + spend Δ. |
| [`anomaly-scan`](src/skills/anomaly-scan.ts) | Pattern scan: late filings, new lobbyists, ex-staffer hires, issue churn, new govt entities. |
| [`brief`](src/skills/brief.ts) | Composer: entity-profile + spend-analysis + anomaly-scan (+ optional contract-trace) as one shareable brief. |

And one natural-language entrypoint:

- **[`ask`](src/agents/ask.ts)** — Claude tool-use loop. Picks skills,
  executes them, composes narrative.

## The four cross-references that nobody else combines in one agent

1. **LDA + FEC** — this lobbying firm also gave $X to members of the committees of jurisdiction.
2. **LDA + USASpending** — this company spent $X lobbying and received $Y in federal contracts in the same period.
3. **LDA + Congress.gov** — this bill has N registered lobbyists working it; here's the breakdown.
4. **LDA + revolving-door** — this firm hired ex-staffer X three months after they left Senator Y's office.

## MCP

Every skill is exposed over MCP stdio, so lobbyist drops into Claude
Desktop, Claude Code, or Cursor:

```bash
bun run src/cli.ts mcp        # stdio server
```

Register in Claude Code via `.mcp.json`:

```json
{
  "mcpServers": {
    "lobbyist": {
      "command": "bun",
      "args": ["run", "/path/to/lobbyist/src/mcp/server.ts"]
    }
  }
}
```

Tools surfaced: `entity_profile`, `bill_watchers`, `spend_analysis`,
`revolving_door`, `committee_influence`, `contract_trace`,
`coalition_detect`, `filing_diff`, `anomaly_scan`, `compose_brief`,
`recall_entity`, `annotate_entity`, `resolve_config`.

## Memory

Everything you run is persisted to local SQLite. The second query about
Pfizer is cheaper than the first because the entity-resolution graph has
grown.

```bash
# List the 50 most-recently-seen entities
bun run src/cli.ts recall

# Recall briefs for a specific entity
bun run src/cli.ts recall "Pfizer" --brief

# Attach a free-text note that carries into future briefs
bun run src/cli.ts annotate "Pfizer" "Our healthcare beat priority; track Q4 2024 amendments."
```

## Watchlist + alerts

```bash
bun run src/cli.ts watch --add=client:12345 --window=2020-2024-all
bun run src/cli.ts watch --list
bun run src/cli.ts watch --once              # single pass
bun run src/cli.ts watch --interval-minutes=60   # loop
```

Each pass re-runs `entity-profile` for every watchlist entry, diffs
against the previously stored brief, and writes a digest to
`~/.lobbyist/digests/YYYY-MM-DD.md`.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full diagram.
At a glance:

```
       CLI · MCP · ask · watch
              │
       10 deterministic skills
              │
  LDA · OpenFEC · USASpending · Congress.gov  (rate-limit + cache + retry)
              │
       SQLite memory:
       entities + entity_aliases (the moat) + filings + briefs + annotations + watchlist
```

## Privacy & compliance

All public data. No PHI. No PII beyond what filers themselves publish on
government websites. No phone-home telemetry. Cloud inference (Anthropic)
is opt-in and only used for narrative synthesis via `ask` — never for the
numbers. See [SECURITY.md](SECURITY.md) for the full posture.

## Guardrails

- Every claim cites a source filing (LDA filing UUID, FEC filing ID,
  USASpending award key).
- No inference of intent, motive, or quid-pro-quo. Co-occurrence ≠ causation.
- Filed facts vs. derived analysis (ratios, coalition confidence) are
  labeled as such.
- Anomaly flags are suggestions, not accusations.
- No claims about unregistered lobbying.
- Timestamps on everything — LDA filings are frequently amended.

## License

MIT. See [LICENSE](LICENSE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
