# lobbyist

> **An AI senior lobbying analyst on your laptop.**
> Follow the money from the K Street office to the committee vote to the federal contract.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.1+-black.svg)](https://bun.sh)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-purple.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-45%2F45%20passing-brightgreen.svg)](test/)

Type a company name → get a fully-cited lobbying brief in 30 seconds.
Ask a question in English → get a cross-referenced answer across Senate
LDA filings, FEC campaign contributions, USASpending federal contracts,
and Congress.gov bill metadata.

**OpenSecrets killed their API in April 2025.** OpenLobby is a single
static website, not a tool. Lex Machina-scale incumbents don't exist
here. This is the open-source toolkit we deserve.

```
$ lobbyist entity-profile "Pfizer Inc" --year-start=2020 --year-end=2024
```
```markdown
## Pfizer Inc — Lobbying Profile

Pfizer Inc filed 20 LDA filings covering 2020–2024, with $57,520,000
in reported lobbying spend [total_spend].

- Activity window: 2020 → 2024 (20 active quarters).

### Spend by year

| Year | Filings | Reported spend |
| ---- | ------- | -------------- |
| 2020 | 4       | $11,120,000 [year_2020] |
| 2021 | 4       | $12,560,000 [year_2021] |
| 2022 | 4       | $14,400,000 [year_2022] |
| 2023 | 4       | $11,220,000 [year_2023] |
| 2024 | 4       |  $8,220,000 [year_2024] |

### Lobbying firms employed (top 5 by filings)

- Akin Gump Strauss Hauer & Feld LLP — 20 filings
- Invariant LLC — 19 filings
- …

### Issues lobbied (top 5 by filing count)

- HCR — Health Issues (18 filings)
- MMM — Medicare/Medicaid (14 filings)
- TAX — Taxation (12 filings)
- …

> Filed facts only. Every figure cites a Senate LDA filing.
> The tool cannot detect unregistered lobbying.
```

*Illustrative — numbers depend on the live LDA database at fetch time. Every number in real output links to the underlying filing.*

### Or the headline cross-reference:

```
$ lobbyist contract-trace "Lockheed Martin" --year-start=2020 --year-end=2024
```
```markdown
## Lockheed Martin Corporation — Lobbying-to-Contracts Trace

Window: 2020–2024.

- **LDA lobbying spend:** $61,830,000 across 20 filings [lda_total].
- **USASpending contract awards:** $311,427,184,956 across 823 awards [usa_top].
- **Derived ratio:** 5,037× ($311.4B in contracts per $61.8M in reported
  lobbying). _Derived; does not imply causation._

### Awards by year

| Year | Awards | Total |
| ---- | ------ | ----- |
| 2020 | 201    | $60,214,832,401 [usa_2020] |
| 2021 | 174    | $68,932,117,209 [usa_2021] |
| 2022 | 165    | $62,081,442,888 [usa_2022] |
| 2023 | 158    | $58,992,811,114 [usa_2023] |
| 2024 | 125    | $61,206,781,344 [usa_2024] |

### Top awarding agencies

- **Department of the Navy** — $94.8B across 211 awards.
- **Department of the Air Force** — $83.2B across 174 awards.
- **Missile Defense Agency** — $52.6B across 41 awards.
- …

> Co-occurrence, not causation. Federal contracts awarded to a lobbying
> client are NOT proof that lobbying caused them.
```

*Illustrative. Every number links to a USASpending award page or an LDA filing PDF.*

---

## Install in 60 seconds

```bash
git clone https://github.com/toddegray/lobbyist && cd lobbyist
bun install

# Make `lobbyist` a global command (dev mode — no rebuild after edits):
mkdir -p ~/.bun/bin && cat > ~/.bun/bin/lobbyist <<EOF
#!/usr/bin/env bash
exec bun run "$(pwd)/src/cli.ts" "\$@"
EOF
chmod +x ~/.bun/bin/lobbyist

# Make sure ~/.bun/bin is on PATH (skip if already there):
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
#   bash users: swap ~/.zshrc for ~/.bashrc

lobbyist init                     # interactive setup → ~/.lobbyist/config.json
lobbyist ping                     # sanity-check your LDA key
```

That's it. No Docker, no database server, no cloud account. The whole
thing is one SQLite file at `~/.lobbyist/data/lobbyist.db`.

**Prefer a standalone binary?** `bun run build` produces `./bin/lobbyist`
(~60 MB, self-contained — no Bun required at runtime) that you can
symlink anywhere on `PATH`:
```bash
bun run build && ln -sf "$(pwd)/bin/lobbyist" ~/.bun/bin/lobbyist
```

**Requires:** [Bun 1.1+](https://bun.sh/docs/installation).

**You'll need:**

- [x] **Senate LDA token** — free, instant, from <https://lda.senate.gov/api/register/>. Required.
- [ ] OpenFEC key — free, instant, from <https://api.open.fec.gov/developers/>. Optional, unlocks `committee-influence` + Congress.gov fallback.
- [ ] Anthropic key — optional, unlocks the `ask` natural-language orchestrator.

`lobbyist init` walks you through all three.

---

## First thirty seconds

```bash
# Full profile for any registered lobbying client
lobbyist entity-profile "Amazon.com Services LLC"

# Who's lobbying on a bill?
lobbyist bill-watchers --bill="CHIPS Act"

# Quarter-over-quarter spend with anomaly flags
lobbyist spend-analysis "Exxon Mobil Corporation"

# English → the right tools → a synthesized answer
lobbyist ask "Which drug-pricing clients gave the most to Senate Finance members in 2024?"
```

Every command writes a markdown brief to stdout and persists a typed JSON
envelope to local memory. Add `--format=json` for the raw envelope or
`--write=path.md` to save.

**What to expect on a cold cache:**

| | Cold (first time) | Warm (cached) |
| --- | --- | --- |
| `entity-profile` | 10–30 s | <100 ms |
| `bill-watchers` | 20–60 s | <100 ms |
| `committee-influence` (LDA+FEC) | 60–120 s | <200 ms |
| `contract-trace` (LDA+USASpending) | 30–60 s | <200 ms |

API responses are cached to disk under `~/.lobbyist/cache/` for 24 hours
by default. Re-running the same command is near-instant. You can blow
away the cache any time — it's just JSON.

---

## The ten skills

| Skill | Answers the question |
| --- | --- |
| **`entity-profile`** | Who lobbies, for whom, on what, with what spend trend? |
| **`bill-watchers`** | Who's working this bill (or this issue code) and how much are they spending? |
| **`spend-analysis`** | How has this client's spend moved quarter-over-quarter, and are any quarters weird? |
| **`revolving-door`** | Where did this person work in government before they registered to lobby? What clients do they have? |
| **`committee-influence`** 🧲 | On issues this member's committee handles — who's lobbying, and who gave to their campaign? *(LDA+FEC)* |
| **`contract-trace`** 🧲 | How much is this client spending on lobbying vs. winning in federal contracts? *(LDA+USASpending)* |
| **`coalition-detect`** | Which entities are lobbying together through the same firms on the same issues? |
| **`filing-diff`** | What changed for this client between Q3 and Q4 — new lobbyists, new issues, spend delta? |
| **`anomaly-scan`** | Late filings, ex-staffer hires, sudden issue churn, new government bodies being contacted. |
| **`brief`** | Run `entity-profile + spend-analysis + anomaly-scan (+ contract-trace)` as one shareable document. |

🧲 = cross-reference skill. Combines datasets that nobody else joins in one agent.

See [`examples/`](examples/) for a runnable recipe per skill.

---

## The four joins nobody else combines

This is the reason an agent is the right tool for the job.

### 1. LDA + FEC → **who's hiring lobbyists and writing campaign checks in the same breath**

```bash
lobbyist committee-influence \
  --member="Bernie Sanders" \
  --issue-codes=HCR,MMM \
  --cycle=2024
```

For every top lobbying client on a member's issues of jurisdiction, pulls
FEC Schedule A contributions from that client's employees to the member's
principal campaign committee. Ranked table, every number cited.

### 2. LDA + USASpending → **lobbying spend vs. federal contract awards**

```bash
lobbyist contract-trace "Lockheed Martin" --year-start=2020 --year-end=2024
```

Computes total LDA-reported lobbying spend against total federal contract
awards to the same recipient, plus a derived (**non-causal**) ratio, plus
the top awards with agency and description.

### 3. LDA + Congress.gov → **every registered lobbyist on a specific bill**

```bash
lobbyist bill-watchers --bill="Kids Online Safety Act" --year-start=2022 --year-end=2024
```

Ranked list of clients lobbying on a bill with their firms and spend.
v1.0 will add Congress.gov bill metadata + sponsor + committees of
jurisdiction.

### 4. LDA revolving-door → **this firm hired that ex-staffer three months after they left**

```bash
lobbyist revolving-door "Heather Podesta" --year-start=2010 --year-end=2024
```

Surfaces covered-position disclosures, employer firms, client list over
a career. The tool reports what was filed; it does not interpret
cooling-off compliance (that's a legal question for a human).

---

## Natural language — `ask`

If you have an Anthropic key, skip the subcommands:

```bash
lobbyist ask "How has Palantir's lobbying-to-contracts ratio changed since 2019?"
```

Claude picks the right skills, runs them, and composes a narrative that
cites every number. Add `--stats` for token usage, `--verbose` to watch
the tool calls, `--max-iterations=N` for long questions.

```bash
lobbyist ask "Compare Amazon and Microsoft lobbying in 2024 — who hired whom, spent what, worked what bills?"
lobbyist ask "Who are the top 10 defense lobbying clients by 2020–2024 LDA spend, and what are their contract totals?"
lobbyist ask "Diff Exxon's 2022 vs 2024 lobbying — what changed?"
```

---

## MCP — drop into Claude Code, Claude Desktop, or Cursor

```bash
lobbyist mcp        # stdio server
```

Register in `.mcp.json`:

```json
{
  "mcpServers": {
    "lobbyist": {
      "command": "lobbyist",
      "args": ["mcp"]
    }
  }
}
```

All ten skills plus `recall_entity`, `annotate_entity`, and
`resolve_config` are exposed as MCP tools. Works anywhere MCP works.

---

## Memory — why the tenth query is better than the first

Every skill run persists a typed Brief plus growing entity-resolution
aliases ("Pfizer Inc" ≡ "PFIZER INC" ≡ "Pfizer, Inc.") to local SQLite.

```bash
lobbyist recall                              # 50 most-recently-seen entities
lobbyist recall "Pfizer" --brief             # latest entity-profile for Pfizer
lobbyist annotate "Pfizer" "Our Q4 priority — watch for amendments after earnings"
```

### Watchlist + digest

Set it and forget it:

```bash
lobbyist watch --add=client:12345 --window=2020-2024-all
lobbyist watch --list
lobbyist watch --once                        # single pass
lobbyist watch --interval-minutes=60         # daemonized
```

Each pass re-runs `entity-profile` for every watchlist entry, diffs
against the previously stored brief, and writes a digest to
`~/.lobbyist/digests/YYYY-MM-DD.md`.

---

## Output formats

Every skill accepts:

```bash
--format=md        # default — human-readable markdown with inline [citations]
--format=json      # structured envelope (entity + data + citations + markdown)
--write=path       # write to a file instead of stdout
```

JSON is what MCP clients and `ask` consume. Good for piping to `jq`,
Sheets, Google Docs, or your own tooling:

```bash
lobbyist contract-trace "Raytheon" --format=json | \
  jq '.data.usaspending.top_awards[] | {amount, agency, description}'
```

---

## Architecture at a glance

```
       CLI · MCP server · ask orchestrator · watch daemon
                              │
                    10 deterministic skills
                              │
    LDA · OpenFEC · USASpending · Congress.gov
                 (rate-limit + on-disk cache + retry)
                              │
                     SQLite memory:
     entities + entity_aliases (the moat) + filings
        + briefs + annotations + watchlist
```

**Full diagram and component notes:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Privacy, compliance, and what this tool *cannot* do

**All public data.** No PHI. No PII beyond what filers publish on
government websites. No phone-home telemetry. Cloud inference (Anthropic)
is opt-in and only used for narrative synthesis via `ask` — never for
the numbers. See [SECURITY.md](SECURITY.md) for the full posture.

**The tool reports what was filed.** It cannot detect:

- Unregistered lobbying or shadow lobbying
- Off-the-books influence
- Coordinated campaigns that bypass LDA registration
- Intent, motive, or quid-pro-quo

When a brief says "this client spent $X while this member received $Y," it
is reporting a disclosed overlap — **not** inferring causation. Readers
draw their own conclusions.

Anomaly flags are suggestions, not accusations.

---

## Guardrails, in one screen

- Every number cites a source filing (LDA UUID, FEC filing ID, USASpending award key, Congress.gov bill slug).
- Filed facts (spend, rosters) and derived analysis (ratios, coalition confidence) are labeled distinctly in the output.
- No intent language — never "to curry favor," "to buy access," "in exchange for."
- No claims about unregistered lobbying.
- Anomaly flags are "unusual," not "improper."
- Timestamps on everything — LDA filings are frequently amended.
- Shipped AS-IS under the MIT license with no warranty. Every output is a **draft for a human analyst to review**.

---

## For contributors

```bash
bun install
bun test                          # 45 tests across 10 files
bun tsc --noEmit                  # clean typecheck
bun run dev <subcommand> [flags]  # run without a build
bun run build                     # compile standalone bin/lobbyist
bun run mcp                       # run MCP server directly
```

**CLAUDE.md** in the repo root is the immutable-rules document — read it
before adding a skill.

PRs welcome. Please add tests.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Current: **v0.5.0** (2026-04-22) —
10 skills, 4 data sources, ask orchestrator, MCP server, 45 tests.

## License

[MIT](LICENSE). Do what you want. No warranty.

---

*Built by [Todd Gray](https://github.com/toddegray) as part of the [OneManSaaS](https://github.com/toddegray) open-source toolkit.*
