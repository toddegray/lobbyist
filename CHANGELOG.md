# Changelog

Notable changes to lobbyist. Dates are calendar dates; semver follows.

## Unreleased

### Added
- **`bill-watchers --congress-bill=CONGRESS/TYPE/NUMBER`** — exact
  Congress.gov bill reference (e.g. `117/HR/4346`). Enriches the brief
  with the bill's official title, sponsor (name / party / state),
  introduction date, latest action, and committees of jurisdiction.
  The official title is also used as the LDA substring for broader
  coverage than the user's typed phrasing.
- **7 Congress.gov endpoint tests** (`test/congress-endpoints.test.ts`)
  pinning real live response shapes — `getBill`, `getBillCommittees`,
  `getMember`, plus URL and label helpers. Fixture data captured live
  in April 2026.

### Fixed
- **Congress.gov schemas** previously shipped with fabricated shapes
  (e.g. `member.terms` written as `{item: [...]}` when the real API
  returns a list; required fields that don't exist). All rewritten
  against verified live responses. MCP tool schema + ask orchestrator
  tool schema updated to surface the new `congress_bill` arg.

## [0.5.0] — 2026-04-22

### Added
- **10 total skills** covering the full v0.5 roster:
  - `entity-profile` — full lobbying profile for a client.
  - `bill-watchers` — who's lobbying on a given bill or issue code.
  - `spend-analysis` — quarter-over-quarter trend + anomaly flags.
  - `revolving-door` — career arc for an individual lobbyist.
  - `committee-influence` — **LDA + FEC join**. Lobbying clients on issues of
    jurisdiction × FEC contributions to a member's campaign committee.
  - `contract-trace` — **LDA + USASpending join**. Lobbying spend vs
    federal contract awards.
  - `coalition-detect` — groups of clients lobbying together via shared
    firm / issue / quarter.
  - `filing-diff` — diff a client's filings between two windows (years or
    single quarters).
  - `anomaly-scan` — pattern scan: late filings, new lobbyists, ex-staffer
    hires (via `covered_position`), issue churn, new govt entities.
  - `brief` — composer that runs entity-profile + spend-analysis +
    anomaly-scan (+ optional contract-trace) and concatenates.
- **Four data-source clients** with shared rate-limit + on-disk cache + retry
  surface:
  - `LdaClient` — Senate LDA API.
  - `OpenFecClient` — OpenFEC, ported from fec-analyst (user-approved).
  - `UsaSpendingClient` — USASpending.gov (no auth).
  - `CongressClient` — Congress.gov API (bill + member metadata).
- **`ask` natural-language orchestrator** using the Claude tool-use loop.
  Claude picks the right skill(s) and composes a narrative.
- **MCP server** exposing all 10 skills plus `recall_entity`,
  `annotate_entity`, `resolve_config`.
- **Memory ops CLI:** `recall`, `annotate`, `watch` (with `--add`,
  `--remove`, `--list`, `--once`, `--interval-minutes=N`).
- **Entity-resolution polish:** Levenshtein + Jaro–Winkler fuzzy match
  (`src/core/fuzzy.ts`); `pickBestNamed` heuristic in `resolve.ts` adds
  normalized-equality + fuzzy-fallback stages.
- **Tests:** 45 bun tests across 10 files covering DB, fuzzy, config,
  types, resolve, skills, filing-diff, anomaly-scan, coalition-detect,
  ask-helpers.
- **Docs:** `docs/ARCHITECTURE.md` with the full architecture diagram.

### Changed
- Config schema now carries `openfec_api_key` + `congress_api_key`
  (shares api.data.gov key space with OpenFEC when unset).
- `upsertFilingsBatch` now upserts the entity rows BEFORE the alias rows
  (fixes a FK violation caught in v0.1 testing).

### Notes
- LDA API migration: the Senate is moving `lda.senate.gov/api/` to
  `lda.gov/api/` on 2026-06-30. `LdaClient` has
  `LDA_BASE_URL_FALLBACKS` documented; v1.0 will wire the fallback.

## [0.1.0] — 2026-04-22

### Added
- Initial scaffold at `/Volumes/External/gbrain/lobbyist` mirroring
  fec-analyst and integrator.
- Three hero skills: `entity-profile`, `bill-watchers`, `spend-analysis`.
- `LdaClient` with rate limit + cache + retry.
- `OpenFecClient` ported from fec-analyst (user-approved).
- bun:sqlite memory layer with mandatory Statement cache.
- CLI + MCP server wiring the three skills.
- 24 bun tests, `bun tsc --noEmit` clean.
