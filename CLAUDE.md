# CLAUDE.md

lobbyist is an AI senior lobbying analyst. Clean-room build, MIT licensed to Todd Gray. Built on the Senate LDA public API, cross-referenced with FEC campaign contributions and USASpending.gov federal contracts.

## Immutable product rules

1. **Public data only.** Senate LDA (lda.senate.gov/api, migrating to lda.gov 06/30/2026), FEC OpenFEC, USASpending.gov, Congress.gov, bioguide.congress.gov, House Lobbying Disclosure. No scraping, no proprietary feeds, no paid APIs, no OpenSecrets dependency (they killed their API April 2025 — that's the market opening).
2. **Every claim cites a filing.** Narrative output must link to the underlying LDA filing ID, FEC filing ID, or USASpending award ID. Hallucinated spend figures, lobbyist names, or contract amounts are unshippable.
3. **Reports the disclosed world only.** The tool reports what filers themselves reported to the government. It cannot detect unregistered lobbying, shadow lobbying, or off-the-books influence. The README is explicit about this.
4. **No inference of intent or motive.** The tool reports what was filed, never speculates about what was "really" happening. Anomaly flags are suggestions, not accusations — "sudden spend increase in Q3" not "this is suspicious." No intent language: no "to curry favor," "to buy access," "in exchange for."
5. **Reproducible.** The same entity against the same filing set produces byte-identical structured output. LLM narrative may vary; spend totals, lobbyist rosters, and citations must not.
6. **User-settable config.** Every knob the user might plausibly want to change is settable via `lobbyist init`. Env vars are the escape hatch, not the front door.
7. **Entity-agnostic code paths.** No company-, firm-, committee-, or person-specific branches. If a code path branches on a specific entity name, it's a bug. Vendor/client quirks live in the entity-resolution memory layer, observed from filings, not hard-coded.
8. **Local-first.** Memory stays on disk, local to the user. No phone-home telemetry. Cloud inference (Anthropic) is opt-in, for narrative synthesis only — never for the numbers.
9. **Filed facts vs derived analysis.** Spend totals, lobbyist rosters, and client lists are filed facts — cite the filing. ROI ratios, coalition detections, and cross-source joins are derived analysis — label them as such in the brief.
10. **Timestamps on everything.** LDA filings are frequently amended. Every stored datum carries a fetched_at and (where possible) a filing_amended_at.

## Architecture

- **Language:** TypeScript on Bun.
- **Memory substrate:** bun:sqlite (native, synchronous under an async wrapper) with a statement cache in the DbClient (re-preparing in tight loops triggers "closed database" errors). Schema is standard SQL that also runs on libsql/Turso.
- **Data sources:** Senate LDA API (primary), Senate Office of Public Records bulk XML (historical since 1999), House Clerk Lobbying Disclosure, FEC OpenFEC (cross-reference), USASpending.gov (contract ROI), Congress.gov (bill metadata), bioguide.congress.gov (member biographical data).
- **Agent runtime:** Claude Agent SDK. Orchestrator + specialist sub-agents per skill (v0.5).
- **Model routing:** Ollama (qwen2.5-coder and similar) for local inference by default; Anthropic available as opt-in for narrative synthesis.
- **Surfaces:** CLI, MCP server (stdio), web UI (v1.0), watchlist + alerts (v1.0).

## Directory layout

```
src/
  core/         Domain types, LDA client, OpenFEC client, config, entity-resolution helpers
  db/           Engine (bun:sqlite), schema, repos
  skills/       Skill implementations (one per capability)
  cli/          CLI commands
  mcp/          MCP server
  agents/       Orchestrator + specialist sub-agents (v0.5)
  cli.ts        CLI entry
  mcp/server.ts MCP entry
examples/       Committed hero briefs (bipartisan across industries)
test/           Unit + integration tests
docs/           Architecture, skill specs
```

## Skills (v0.1 → v1.0)

**v0.1 (this scaffold):**
- `entity-profile` — full lobbying profile for a company, trade association, or law firm: registrations, quarterly activity, lobbyists employed, issues lobbied, committees contacted, spend trend
- `bill-watchers` — given a bill number or issue area, every registered lobbyist working it, their clients, their spend, their recent activity
- `spend-analysis` — spend trends, top spenders, quarter-over-quarter changes, anomalies for an entity or issue

**v0.5 (week 1 polish):**
- `revolving-door` — given a person, full career arc: government roles, covered positions, lobbying registrations, clients lobbied for, cooling-off compliance flags
- `committee-influence` — given a committee or member, cross-reference who's lobbying their jurisdiction, who gave to their campaign (LDA + FEC join), which ex-staffers now lobby them
- `contract-trace` — given an entity, cross-reference lobbying spend with federal contracts received (LDA + USASpending join) to produce a lobbying-to-contracts flow
- `coalition-detect` — which entities lobby together (shared lobbying firms, shared bill priorities, coordinated filings)
- `filing-diff` — compare an entity's filings across quarters to flag new issues, new lobbyists, withdrawn issues, spend changes
- `anomaly-scan` — unusual patterns: sudden spend spikes, newly hired ex-staffers, inconsistent issue codes, late filings
- `brief` — compose a full narrative brief from any combination of the above

**v1.0 (launch):**
- entity-resolution polish (the hard part — Pfizer Inc vs PFIZER INC vs Pfizer, Inc.)
- watchlist + alerts
- web UI
- LDA → lda.gov migration handling (06/30/2026)

## The four cross-references that nobody else combines

1. **LDA + FEC** — this lobbying firm also gave $X to members of the committees of jurisdiction.
2. **LDA + USASpending** — this company spent $X lobbying and received $Y in federal contracts in the same period.
3. **LDA + Congress.gov** — this bill has N registered lobbyists working it, here's the breakdown by position.
4. **LDA + revolving-door** — this firm hired ex-staffer X three months after they left the office of Senator Y, who chairs the committee they're lobbying.

## Memory (the compounding layer — this is the moat)

- **Entity memory:** per company, trade association, law firm, LLC — every registration, every quarterly filing, every lobbyist employed, every issue lobbied, normalized across the inevitable name variations.
- **Person memory:** per lobbyist — all registrations across their career, covered-position history, client list, ex-employers, compliance flags.
- **Bill/issue memory:** per bill number and per issue code — every lobbyist who's ever touched it, every entity that's ever lobbied on it, spend totals, coalition groupings.
- **Committee/member memory:** per committee and per member — who lobbies their jurisdiction, who gives to their campaigns (joined with FEC memory), which ex-staffers now lobby them.
- **Coalition memory:** detected groupings — entities that consistently lobby together or coordinate on the same bills.
- **Cross-reference memory:** the entity-resolution graph that ties a Senate LDA filing's "Pfizer Inc" to FEC's "PFIZER INC PAC" to USASpending's "PFIZER INC." This is the expensive, compounding asset.
- **User context memory:** user's beat (healthcare, defense, tech, finance) and watchlist, applied silently to every request.
- **Annotation memory:** user notes per entity / per bill / per person carry forward.

The second query about Pfizer's healthcare IT lobbying is dramatically better than the first because the entity-resolution graph has grown.

## Privacy posture

- Fully local by default. SQLite on disk, no cloud sync.
- All public data. No PHI, no PII beyond what filers themselves publish on government websites.
- No compliance surface area. The README is explicit that the tool reports what filers themselves reported and cannot detect unregistered lobbying.
- Cloud inference (Anthropic) is opt-in and only used for narrative synthesis, never for the numbers.

## Don't

- Don't infer intent, motive, or quid-pro-quo. The tool reports filings, not conspiracies.
- Don't hard-code an entity, firm, committee, or member. Every code path is parameterized.
- Don't phone home. No telemetry, no usage pings, no remote config fetches.
- Don't claim to detect unregistered lobbying. The tool reports the disclosed world only.
- Don't rewrite code from Bellwether, integrator, or gbrain. Architectural inspiration only.
- Exception: OpenFEC client was ported from fec-analyst deliberately (user-approved) to avoid re-implementing the same rate-limit + cache + retry surface twice. File header documents the provenance.
