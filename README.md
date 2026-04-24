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
## PFIZER, INC. — Lobbying Profile

PFIZER, INC. filed 294 LDA filings covering 2020–2024, with
$100,375,000 in reported lobbying spend [total_spend].

- Activity window: 2020 → 2024 (20 active quarters).
- Registered address: NY, US.

### Spend by year

| Year | Filings | Reported spend |
| ---- | ------- | -------------- |
| 2020 | 55      | $13,830,000 [year_2020] |
| 2021 | 59      | $16,050,000 [year_2021] |
| 2022 | 65      | $27,690,000 [year_2022] |
| 2023 | 67      | $17,045,000 [year_2023] |
| 2024 | 48      | $25,760,000 [year_2024] |

### Lobbying firms employed (top 5 by filings)

- **PFIZER INC.** — 31 filings, $87,380,000 reported.
- **THE WASHINGTON TAX & PUBLIC POLICY GROUP** — 21 filings, $1,480,000 reported.
- **AVOQ, LLC** — 22 filings, $1,290,000 reported.
- **NVG, LLC** — 20 filings, $1,280,000 reported.
- **THE DUBERSTEIN GROUP INC.** — 20 filings, $1,260,000 reported.

### Issues lobbied (top 5 by filing count)

- **HCR** — Health Issues (183 filings).
- **TRD** — Trade, domestic/foreign (123 filings).
- **TAX** — Taxation / Internal Revenue Code (105 filings).
- **MMM** — Medicare / Medicaid (77 filings).
- **CPT** — Copyright / Patent / Trademark (71 filings).

### Government entities contacted (top 5)

- SENATE (551 filings).
- HOUSE OF REPRESENTATIVES (534 filings).
- Health & Human Services, Dept of (HHS) (114 filings).
- White House Office (113 filings).
- U.S. Trade Representative (USTR) (88 filings).

> Filed facts only. Every figure cites a Senate LDA filing.
> The tool cannot detect unregistered lobbying.
```

*Real output captured from the live LDA database in April 2026. Exact
figures drift as filings are amended; the tool re-fetches on demand.*

### Or the headline cross-reference — LDA × FEC in one query:

```
$ lobbyist committee-influence --member="Bernie Sanders" \
    --issue-codes=HCR,MMM --cycle=2024
```
```markdown
## Committee-of-jurisdiction influence: SANDERS, BERNARD (IND)-VT

Issue codes examined: **HCR, MMM**. FEC cycle: 2024.

On the LDA side: **71** clients filed **241** filings on these issues,
with **$36,040,508** reported spend.
On the FEC side: of the top 10 lobbying clients, **7** had employees
contribute to FRIENDS OF BERNIE SANDERS [committee_fec], totalling
**$37,040**.

### LDA spend × FEC contributions (top clients)

| Client | LDA filings | LDA spend | FEC contribs | Contrib txns |
| --- | --- | --- | --- | --- |
| **CALIFORNIA HOSPITAL ASSOCIATION** | 19 | $7,850,000 | $17,844 | 500 |
| **KAISER FOUNDATION HEALTH PLAN INC** | 5 | $7,280,000 | $5,330 | 300 |
| **GENENTECH INC** | 2 | $4,050,000 | $632 | 27 |
| **NATIONAL ASSOCIATION OF COMMUNITY HEALTH CENTERS** | 11 | $3,808,400 | $11,893 | 500 |
| **F HOFFMANN-LA ROCHE LTD AND ITS AFFILIATES** | 18 | $2,225,000 | $0 | 0 |
| **NATIONAL FOOTBALL LEAGUE** | 25 | $1,990,000 | $0 | 0 |
| **CHRO ASSOCIATION (FKA HR POLICY ASSOCIATION)** | 2 | $1,550,000 | $583 | 11 |
| **PLASMA PROTEIN THERAPEUTICS ASSOCIATION** | 9 | $1,430,000 | $0 | 0 |
| **NATIONAL RIGHT LIFE COMMITTEE** | 22 | $1,408,000 | $681 | 40 |
| **UT SOUTHWESTERN MEDICAL CENTER** | 8 | $905,125 | $77 | 10 |

> Disclosed overlap between lobbying spend and campaign contributions.
> This is NOT a claim of quid-pro-quo; causality cannot be inferred
> from the filings. The tool surfaces the overlap; the reader decides
> what it means.
```

*Real output. Every filing ID, spend figure, and contribution dollar
links back to its source record — `--format=json` dumps the full
structured envelope with citations.*

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
- [ ] OpenFEC key — free, instant, from <https://api.open.fec.gov/developers/>. Optional, unlocks `committee-influence` (LDA+FEC join) and `bill-watchers --congress-bill=…` (Congress.gov enrichment). One api.data.gov key works for both FEC and Congress.gov.
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
| **`bill-watchers`** 🧲 | Who's working this bill (or this issue code) and how much are they spending? Optionally enriches with Congress.gov bill metadata + committees of jurisdiction. |
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
# Use the official Congress.gov reference for exact match + metadata
lobbyist bill-watchers --congress-bill=117/HR/4346 --year-start=2021 --year-end=2023

# Or use a free-text substring (no Congress.gov enrichment needed)
lobbyist bill-watchers --bill="Kids Online Safety Act" --year-start=2022 --year-end=2024
```

When `--congress-bill=CONGRESS/TYPE/NUMBER` is supplied, the brief is
enriched with the bill's official title, sponsor (name / party / state),
introduction date, latest action, and committees of jurisdiction — all
pulled from Congress.gov. The official title is also used as the LDA
substring for broader coverage than the user's typed phrasing.

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
